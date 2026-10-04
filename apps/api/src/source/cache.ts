import { ByteLru, type Clock } from '../cache/lru.ts';
import type { Config } from '../config.ts';
import type { FetchedSource } from './fetcher.ts';

export class SourceCache {
  readonly #lru: ByteLru<FetchedSource>;

  constructor(limits: Pick<Config, 'sourceCacheMaxBytes' | 'sourceCacheTtlSeconds'>, clock: Clock) {
    this.#lru = new ByteLru({
      maxBytes: limits.sourceCacheMaxBytes,
      ttlMs: limits.sourceCacheTtlSeconds * 1000,
      sizeOf: (source) => source.bytes.byteLength,
      clock,
    });
  }

  get(url: URL): FetchedSource | undefined {
    return this.#lru.get(url.href);
  }

  set(url: URL, source: FetchedSource): void {
    this.#lru.set(url.href, source);
  }
}
