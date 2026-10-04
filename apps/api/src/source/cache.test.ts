import { describe, expect, it } from 'vitest';
import { SourceCache } from './cache.ts';
import type { FetchedSource } from './fetcher.ts';

function source(byteLength: number): FetchedSource {
  return {
    bytes: new Uint8Array(byteLength),
    finalUrl: new URL('http://cdn.example.com/a.png'),
    upstream: {},
  };
}

function sourceCache() {
  const clock = { time: 0, now: () => clock.time };
  const limits = { sourceCacheMaxBytes: 100, sourceCacheTtlSeconds: 300 };
  return { cache: new SourceCache(limits, clock), clock };
}

describe('SourceCache', () => {
  it('keys by href, so URLs that parse to the same href share an entry', () => {
    const { cache } = sourceCache();
    const stored = source(10);
    cache.set(new URL('HTTP://Example.COM:80/a.png'), stored);
    expect(cache.get(new URL('http://example.com/a.png'))).toBe(stored);
    expect(cache.get(new URL('http://example.com/a.png?v=2'))).toBeUndefined();
  });

  it('expires a source after SOURCE_CACHE_TTL_SECONDS', () => {
    const { cache, clock } = sourceCache();
    const url = new URL('http://example.com/a.png');
    cache.set(url, source(10));
    clock.time = 299_999;
    expect(cache.get(url)).toBeDefined();
    clock.time = 300_000;
    expect(cache.get(url)).toBeUndefined();
  });

  it('measures SOURCE_CACHE_MAX_BYTES against the length of the source bytes', () => {
    const { cache } = sourceCache();
    const a = new URL('http://example.com/a.png');
    const b = new URL('http://example.com/b.png');
    cache.set(a, source(60));
    cache.set(b, source(40));
    expect(cache.get(a)).toBeDefined();
    expect(cache.get(b)).toBeDefined();
    cache.set(new URL('http://example.com/c.png'), source(1));
    expect(cache.get(a)).toBeUndefined();
  });
});
