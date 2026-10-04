export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number; // seconds until the current window ends
};

export interface RateLimiter {
  consume(key: string, nowMs: number): Promise<RateLimitDecision>;
}

export const WINDOW_MS = 60_000;

export function currentWindow(nowMs: number): {
  index: number;
  endMs: number;
  resetSeconds: number;
} {
  const index = Math.floor(nowMs / WINDOW_MS);
  const endMs = (index + 1) * WINDOW_MS;
  return { index, endMs, resetSeconds: Math.ceil((endMs - nowMs) / 1000) };
}

export function decide(count: number, limit: number, resetSeconds: number): RateLimitDecision {
  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    resetSeconds,
  };
}
