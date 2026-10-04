import type { MiddlewareHandler } from 'hono';
import type { Clock } from '../../cache/lru.ts';
import type { Config } from '../../config.ts';
import { ServiceError } from '../../errors.ts';
import { clientKey } from '../../rate-limit/client-key.ts';
import type { RateLimiter } from '../../rate-limit/limiter.ts';
import type { AppEnv } from '../context.ts';

export function rateLimit(
  limiter: RateLimiter,
  config: Pick<Config, 'clientIpSource' | 'trustedProxyCount'>,
  clock: Clock,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = clientKey(
      {
        remoteAddress: c.env.incoming?.socket.remoteAddress,
        headers: (name) => c.req.header(name),
      },
      config,
    );
    const decision = await limiter.consume(key, clock.now());
    if (!decision.allowed) {
      throw new ServiceError(
        'rate_limited',
        `More than ${String(decision.limit)} requests in this minute; retry after ${String(decision.resetSeconds)} s.`,
        { rateLimit: decision },
      );
    }
    await next();
  };
}
