import { describe, expect, it } from 'vitest';
import type { RateLimiter } from './limiter.ts';
import { createMemoryRateLimiter } from './memory.ts';

const WINDOW_START = Date.UTC(2026, 9, 4, 12, 0, 0);
const NEXT_WINDOW = WINDOW_START + 60_000;

async function consumeTimes(limiter: RateLimiter, key: string, nowMs: number, times: number) {
  for (let i = 0; i < times; i += 1) {
    await limiter.consume(key, nowMs);
  }
}

describe('createMemoryRateLimiter', () => {
  it('allows the limit-th request in a window and denies the next', async () => {
    const limiter = createMemoryRateLimiter(3);
    await consumeTimes(limiter, '203.0.113.9', WINDOW_START, 2);
    expect(await limiter.consume('203.0.113.9', WINDOW_START)).toEqual({
      allowed: true,
      limit: 3,
      remaining: 0,
      resetSeconds: 60,
    });
    expect(await limiter.consume('203.0.113.9', WINDOW_START)).toEqual({
      allowed: false,
      limit: 3,
      remaining: 0,
      resetSeconds: 60,
    });
  });

  it('starts a fresh count when the next window begins', async () => {
    const limiter = createMemoryRateLimiter(3);
    await consumeTimes(limiter, '203.0.113.9', WINDOW_START, 4);
    expect(await limiter.consume('203.0.113.9', NEXT_WINDOW)).toEqual({
      allowed: true,
      limit: 3,
      remaining: 2,
      resetSeconds: 60,
    });
  });

  it('forgets an old window once a later one has been seen', async () => {
    const limiter = createMemoryRateLimiter(3);
    await consumeTimes(limiter, '203.0.113.9', WINDOW_START, 4);
    await limiter.consume('198.51.100.7', NEXT_WINDOW);
    expect(await limiter.consume('203.0.113.9', WINDOW_START + 59_000)).toMatchObject({
      allowed: true,
      remaining: 2,
    });
  });

  it('counts two keys independently', async () => {
    const limiter = createMemoryRateLimiter(3);
    await consumeTimes(limiter, '203.0.113.9', WINDOW_START, 4);
    expect(await limiter.consume('198.51.100.7', WINDOW_START)).toMatchObject({
      allowed: true,
      remaining: 2,
    });
  });

  it('reports the seconds left in the window, rounding a partial second up', async () => {
    const limiter = createMemoryRateLimiter(100);
    const resetAt = async (nowMs: number) =>
      (await limiter.consume('203.0.113.9', nowMs)).resetSeconds;
    expect([
      await resetAt(WINDOW_START),
      await resetAt(WINDOW_START + 30_000),
      await resetAt(WINDOW_START + 59_000),
      await resetAt(WINDOW_START + 59_999),
    ]).toEqual([60, 30, 1, 1]);
  });
});
