import { createHash } from 'node:crypto';
import type { CachedResult } from '../cache/result-cache.ts';
import { cacheKey, resolveEncoding, type TransformSpec } from '../image/spec.ts';
import type { Logger } from '../observability/logger.ts';
import type { FetchedSource } from '../source/fetcher.ts';
import type { OperationDeps } from './deps.ts';
import { admitUrl, loadSource } from './load-source.ts';

type ProcessOutcome =
  | { kind: 'image'; result: CachedResult; fromCache: boolean }
  | { kind: 'not_modified'; etag: string };

export async function processImage(
  spec: TransformSpec,
  ifNoneMatch: readonly string[],
  deps: OperationDeps,
  log: Logger,
): Promise<ProcessOutcome> {
  admitUrl(spec.url, deps.policy, log);
  const key = cacheKey(spec);
  const cached = await deps.resultCache.get(key);
  if (cached !== undefined) {
    return matches(ifNoneMatch, cached.etag)
      ? { kind: 'not_modified', etag: cached.etag }
      : { kind: 'image', result: cached, fromCache: true };
  }
  const { source, info } = await loadSource(spec.url, deps, log);
  // With format omitted the key keeps quality, being formed before the source type is known.
  // Once the output is known to be png the ETag drops quality, as toSpec does for png.
  const { url, width, height, crop } = spec;
  const etagKey =
    resolveEncoding(spec, info.format).format === 'png'
      ? cacheKey({ url, width, height, crop, format: 'png' })
      : key;
  const etag = entityTag(etagKey, deps.pipeline.pipelineVersion(), source);
  if (matches(ifNoneMatch, etag)) {
    return { kind: 'not_modified', etag };
  }
  const output = await deps.pipeline.transform(source.bytes, info, spec, deps.limits);
  const result: CachedResult = {
    bytes: output.bytes,
    contentType: output.contentType,
    width: output.width,
    height: output.height,
    format: output.format,
    etag,
  };
  await deps.resultCache.set(key, result);
  return { kind: 'image', result, fromCache: false };
}

function matches(ifNoneMatch: readonly string[], etag: string): boolean {
  return ifNoneMatch.some((candidate) => candidate === '*' || candidate === etag);
}

function entityTag(key: string, pipelineVersion: string, source: FetchedSource): string {
  const identity = sourceIdentity(source);
  const digest = sha256(`${key}|${pipelineVersion}|${identity}`).slice(0, 32);
  return `"${digest}"`;
}

function sourceIdentity({ upstream, bytes }: FetchedSource): string {
  if (upstream.etag !== undefined) {
    return upstream.etag;
  }
  if (upstream.lastModified !== undefined) {
    return `lm:${upstream.lastModified}`;
  }
  return `sha256:${sha256(bytes)}`;
}

function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}
