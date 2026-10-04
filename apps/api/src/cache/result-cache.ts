import type { OutputFormat } from '@image-service/sdk';
import type { Config } from '../config.ts';
import { ByteLru, type Clock } from './lru.ts';

export type CachedResult = {
  bytes: Uint8Array;
  contentType: string;
  width: number;
  height: number;
  format: OutputFormat;
  etag: string;
};

// Async so a shared store can replace the memory implementation without touching callers.
export interface ResultCache {
  get(key: string): Promise<CachedResult | undefined>;
  set(key: string, value: CachedResult): Promise<void>;
}

export class MemoryResultCache implements ResultCache {
  readonly #lru: ByteLru<CachedResult>;

  constructor(limits: Pick<Config, 'resultCacheMaxBytes' | 'resultCacheTtlSeconds'>, clock: Clock) {
    this.#lru = new ByteLru({
      maxBytes: limits.resultCacheMaxBytes,
      ttlMs: limits.resultCacheTtlSeconds * 1000,
      sizeOf: (result) => result.bytes.byteLength,
      clock,
    });
  }

  get(key: string): Promise<CachedResult | undefined> {
    return Promise.resolve(this.#lru.get(key));
  }

  set(key: string, value: CachedResult): Promise<void> {
    this.#lru.set(key, value);
    return Promise.resolve();
  }
}
