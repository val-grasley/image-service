import { describe, expect, it } from 'vitest';
import { type CachedResult, MemoryResultCache, type ResultCache } from './result-cache.ts';

function result(byteLength: number): CachedResult {
  return {
    bytes: new Uint8Array(byteLength),
    contentType: 'image/webp',
    width: 40,
    height: 30,
    format: 'webp',
    etag: '"0123456789abcdef0123456789abcdef"',
  };
}

function memoryCache() {
  const clock = { time: 0, now: () => clock.time };
  const limits = { resultCacheMaxBytes: 100, resultCacheTtlSeconds: 60 };
  const cache: ResultCache = new MemoryResultCache(limits, clock);
  return { cache, clock };
}

describe('MemoryResultCache', () => {
  it('returns the stored result for its key and nothing for another key', async () => {
    const { cache } = memoryCache();
    const stored = result(10);
    await cache.set('v1|url=http://example.com/a.png', stored);
    expect(await cache.get('v1|url=http://example.com/a.png')).toBe(stored);
    expect(await cache.get('v1|url=http://example.com/b.png')).toBeUndefined();
  });

  it('expires a result after RESULT_CACHE_TTL_SECONDS', async () => {
    const { cache, clock } = memoryCache();
    await cache.set('k', result(10));
    clock.time = 59_999;
    expect(await cache.get('k')).toBeDefined();
    clock.time = 60_000;
    expect(await cache.get('k')).toBeUndefined();
  });

  it('measures RESULT_CACHE_MAX_BYTES against the length of the encoded bytes', async () => {
    const { cache } = memoryCache();
    await cache.set('a', result(60));
    await cache.set('b', result(40));
    expect(await cache.get('a')).toBeDefined();
    expect(await cache.get('b')).toBeDefined();
    await cache.set('c', result(1));
    expect(await cache.get('a')).toBeUndefined();
  });
});
