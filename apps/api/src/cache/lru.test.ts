import { describe, expect, it } from 'vitest';
import { ByteLru } from './lru.ts';

function lru(maxBytes: number, ttlMs = 1000) {
  const clock = { time: 0, now: () => clock.time };
  const cache = new ByteLru<string>({ maxBytes, ttlMs, sizeOf: (v) => v.length, clock });
  return { cache, clock };
}

describe('ByteLru', () => {
  it('evicts least recently used entries until the new value fits', () => {
    const { cache } = lru(10);
    cache.set('a', 'aaaa');
    cache.set('b', 'bbbb');
    cache.set('c', 'cc');
    cache.set('d', 'dddddd');
    expect([cache.get('a'), cache.get('b'), cache.get('c'), cache.get('d')]).toEqual([
      undefined,
      undefined,
      'cc',
      'dddddd',
    ]);
  });

  it('refreshes recency on get, so a read entry outlives an unread older one', () => {
    const { cache } = lru(10);
    cache.set('a', 'aaaa');
    cache.set('b', 'bbbb');
    cache.get('a');
    cache.set('c', 'cccc');
    expect([cache.get('a'), cache.get('b'), cache.get('c')]).toEqual(['aaaa', undefined, 'cccc']);
  });

  it('stores a value exactly the size of the budget by evicting everything else', () => {
    const { cache } = lru(10);
    cache.set('a', 'aaaa');
    cache.set('b', 'bbbbbbbbbb');
    expect([cache.get('a'), cache.get('b'), cache.bytes]).toEqual([undefined, 'bbbbbbbbbb', 10]);
  });

  it('rejects a value larger than the budget and keeps the other entries', () => {
    const { cache } = lru(10);
    cache.set('a', 'aaaa');
    cache.set('big', 'xxxxxxxxxxx');
    expect([cache.get('big'), cache.get('a'), cache.bytes]).toEqual([undefined, 'aaaa', 4]);
  });

  it('drops the previous value when a key is replaced by one larger than the budget', () => {
    const { cache } = lru(10);
    cache.set('a', 'aaaa');
    cache.set('a', 'xxxxxxxxxxx');
    expect([cache.get('a'), cache.bytes]).toEqual([undefined, 0]);
  });

  it('serves an entry until its TTL has elapsed, then drops it', () => {
    const { cache, clock } = lru(10, 1000);
    clock.time = 5000;
    cache.set('a', 'aaaa');
    clock.time = 5999;
    expect(cache.get('a')).toBe('aaaa');
    clock.time = 6000;
    expect([cache.get('a'), cache.bytes]).toEqual([undefined, 0]);
  });

  it('does not extend the TTL when an entry is read', () => {
    const { cache, clock } = lru(10, 1000);
    cache.set('a', 'aaaa');
    clock.time = 900;
    cache.get('a');
    clock.time = 1000;
    expect(cache.get('a')).toBeUndefined();
  });

  it('keeps the byte count equal to the stored sizes through replace, delete, and eviction', () => {
    const { cache } = lru(10);
    cache.set('a', 'aaaa');
    cache.set('b', 'bbb');
    expect(cache.bytes).toBe(7);
    cache.set('a', 'aa');
    expect(cache.bytes).toBe(5);
    cache.delete('b');
    expect(cache.bytes).toBe(2);
    cache.delete('missing');
    expect(cache.bytes).toBe(2);
    cache.set('c', 'ccccc');
    cache.set('d', 'dddd');
    expect([cache.get('a'), cache.bytes]).toEqual([undefined, 9]);
  });
});
