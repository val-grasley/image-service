import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { Logger } from '../../observability/logger.ts';
import type { AppEnv } from '../context.ts';

export const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function requestId(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = performance.now();
    const offered = c.req.header('X-Request-Id');
    const id = offered !== undefined && REQUEST_ID.test(offered) ? offered : randomUUID();
    const log = logger.child({ requestId: id });
    c.set('requestId', id);
    c.set('log', log);
    c.header('X-Request-Id', id);
    await next();
    const { status } = c.res;
    const fields = {
      method: c.req.method,
      path: c.req.path,
      status,
      durationMs: Math.round(performance.now() - started),
      code: c.var.errorCode,
      resultCache: c.var.resultCache,
      hostname: c.var.sourceHostname,
    };
    if (status >= 500) {
      log.error('request', fields, c.error);
    } else {
      log.info('request', fields);
    }
  };
}
