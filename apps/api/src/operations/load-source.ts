import { ServiceError } from '../errors.ts';
import type { InspectResult } from '../image/pipeline.ts';
import type { Logger } from '../observability/logger.ts';
import type { FetchedSource } from '../source/fetcher.ts';
import { checkUrl, type PolicyConfig } from '../source/policy.ts';
import { sniff } from '../source/sniff.ts';
import type { OperationDeps } from './deps.ts';

export function admitUrl(url: URL, policy: PolicyConfig, log: Logger): void {
  const decision = checkUrl(url, undefined, policy);
  if (!decision.allowed) {
    log.info('source denied', { hostname: url.hostname, reason: decision.reason });
    throw new ServiceError('url_not_allowed', decision.detail);
  }
}

export async function loadSource(
  url: URL,
  deps: OperationDeps,
  log: Logger,
): Promise<{ source: FetchedSource; info: InspectResult }> {
  let source = deps.sourceCache.get(url);
  if (source === undefined) {
    source = await deps.fetchSource(url, log);
    deps.sourceCache.set(url, source);
  }
  const type = sniff(source.bytes);
  if (type === undefined) {
    throw new ServiceError(
      'unsupported_source_type',
      'The source is not a JPEG, PNG, WebP, GIF, AVIF, or TIFF image.',
    );
  }
  const info = await deps.pipeline.inspect(source.bytes, type);
  const pixels = info.width * info.height;
  if (pixels > deps.limits.maxInputPixels) {
    throw new ServiceError(
      'source_too_large',
      `The source image has ${String(pixels)} pixels; at most ${String(deps.limits.maxInputPixels)} are accepted.`,
    );
  }
  return { source, info };
}
