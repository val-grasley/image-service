import { currentWindow, decide, type RateLimiter } from './limiter.ts';

export function createMemoryRateLimiter(limit: number): RateLimiter {
  const counts = new Map<string, number>();
  let newestWindow = -Infinity;

  return {
    consume(key, nowMs) {
      const window = currentWindow(nowMs);
      if (window.index > newestWindow) {
        // Entries exist only for windows up to the newest seen, so once it advances all are old.
        counts.clear();
        newestWindow = window.index;
      }
      const entry = `${key}:${String(window.index)}`;
      const count = (counts.get(entry) ?? 0) + 1;
      counts.set(entry, count);
      return Promise.resolve(decide(count, limit, window.resetSeconds));
    },
  };
}
