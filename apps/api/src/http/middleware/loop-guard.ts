import type { MiddlewareHandler } from 'hono';
import { ServiceError } from '../../errors.ts';
import { LOOP_MARKER_HEADER } from '../../source/fetcher.ts';
import type { AppEnv } from '../context.ts';

export const loopGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.header(LOOP_MARKER_HEADER) !== undefined) {
    throw new ServiceError(
      'url_not_allowed',
      'The request was made by this service through its fetcher; a source URL cannot point back at the service.',
    );
  }
  await next();
};
