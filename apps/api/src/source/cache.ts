import { ByteLru, type Clock } from '../cache/lru.ts';
import type { Config } from '../config.ts';

export class SourceCache<V extends { bytes: Uint8Array }> {
  readonly #lru: ByteLru<V>;

  constructor(limits: Pick<Config, 'sourceCacheMaxBytes' | 'sourceCacheTtlSeconds'>, clock: Clock) {
    this.#lru = new ByteLru({
      maxBytes: limits.sourceCacheMaxBytes,
      ttlMs: limits.sourceCacheTtlSeconds * 1000,
      sizeOf: (source) => source.bytes.byteLength,
      clock,
    });
  }

  get(url: URL): V | undefined {
    return this.#lru.get(url.href);
  }

  set(url: URL, source: V): void {
    this.#lru.set(url.href, source);
  }
}
