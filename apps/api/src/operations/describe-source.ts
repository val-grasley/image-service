import type { SourceInfo } from '@image-service/sdk';
import type { Logger } from '../observability/logger.ts';
import type { OperationDeps } from './deps.ts';
import { admitUrl, loadSource } from './load-source.ts';

export async function describeSource(
  url: URL,
  deps: OperationDeps,
  log: Logger,
): Promise<SourceInfo> {
  admitUrl(url, deps.policy, log);
  const { source, info } = await loadSource(url, deps, log);
  return {
    url: url.href,
    finalUrl: source.finalUrl.href,
    format: info.format,
    width: info.width,
    height: info.height,
    bytes: source.bytes.byteLength,
    pages: info.pages,
  };
}
