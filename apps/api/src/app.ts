import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import type { Clock } from './cache/lru.ts';
import { MemoryResultCache } from './cache/result-cache.ts';
import type { Config } from './config.ts';
import { ServiceError } from './errors.ts';
import type { AppEnv } from './http/context.ts';
import { invalidParameters, toProblem } from './http/errors.ts';
import { loopGuard } from './http/middleware/loop-guard.ts';
import { rateLimit } from './http/middleware/rate-limit.ts';
import { requestId } from './http/middleware/request-id.ts';
import { addOpenApiDocument } from './http/openapi.ts';
import { addDocsRoute } from './http/routes/docs.ts';
import { addHealthRoute } from './http/routes/health.ts';
import { addInfoRoute } from './http/routes/info.ts';
import { addProcessRoute } from './http/routes/process.ts';
import { inspect, pipelineVersion, transform } from './image/pipeline.ts';
import { createLogger, type Logger } from './observability/logger.ts';
import type { OperationDeps } from './operations/deps.ts';
import { createDynamoDbRateLimiter } from './rate-limit/dynamodb.ts';
import type { RateLimiter } from './rate-limit/limiter.ts';
import { createMemoryRateLimiter } from './rate-limit/memory.ts';
import { SourceCache } from './source/cache.ts';
import { fetchSource, type FetcherDeps } from './source/fetcher.ts';

export type AppDeps = OperationDeps & {
  rateLimiter: RateLimiter;
  logger: Logger;
  clock: Clock;
};

const EXPOSED_HEADERS = [
  'ETag',
  'X-Request-Id',
  'X-Image-Width',
  'X-Image-Height',
  'X-Image-Format',
  'X-Result-Cache',
  'Retry-After',
  'RateLimit',
  'RateLimit-Policy',
];

export function createApp(
  config: Config,
  deps: AppDeps,
  serviceVersion: string,
): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) {
        throw invalidParameters(result.error);
      }
    },
  });

  // Registered first so it runs last, after onError has turned any failure into a response.
  app.use(async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) {
      c.header('Cache-Control', 'no-store');
    }
  });
  app.use(requestId(deps.logger));
  app.use(cors({ origin: '*', allowMethods: ['GET', 'HEAD'], exposeHeaders: EXPOSED_HEADERS }));
  app.use(loopGuard);
  const limit = rateLimit(deps.rateLimiter, config, deps.clock);
  app.use('/process', limit);
  app.use('/info', limit);

  addProcessRoute(app, config, deps);
  addInfoRoute(app, config, deps);
  addHealthRoute(app, serviceVersion);
  addOpenApiDocument(app, serviceVersion);
  addDocsRoute(app);
  refuseOtherMethods(app);

  app.notFound((c) => {
    throw new ServiceError('not_found', `No route matches ${c.req.path}.`);
  });
  app.onError((err, c) => {
    const problem = toProblem(err, c.var.requestId);
    c.set('errorCode', problem.body.code);
    return c.body(JSON.stringify(problem.body), problem.status, problem.headers);
  });
  return app;
}

function refuseOtherMethods(app: OpenAPIHono<AppEnv>): void {
  const methodsByPath = new Map<string, Set<string>>();
  for (const { path, method } of app.routes) {
    if (method !== 'ALL') {
      methodsByPath.set(path, (methodsByPath.get(path) ?? new Set()).add(method));
    }
  }
  for (const [path, methods] of methodsByPath) {
    // Hono answers HEAD with the GET handler, so a path with GET also allows HEAD.
    const allow = methods.has('GET') ? [...methods, 'HEAD'] : [...methods];
    app.all(path, (c) => {
      throw new ServiceError(
        'method_not_allowed',
        `${c.req.method} is not supported on ${path}; use ${allow.join(' or ')}.`,
        { allow },
      );
    });
  }
}

export function defaultDeps(config: Config, serviceVersion: string): AppDeps {
  const clock: Clock = { now: () => Date.now() };
  const logger = createLogger(config.logLevel, undefined, () => clock.now());
  const fetcherDeps: FetcherDeps = {
    policy: config,
    limits: config,
    serviceVersion,
  };
  return {
    fetchSource: (url, log) => fetchSource(url, fetcherDeps, log),
    sourceCache: new SourceCache(config, clock),
    resultCache: new MemoryResultCache(config, clock),
    pipeline: { inspect, transform, pipelineVersion },
    policy: config,
    limits: config,
    rateLimiter: createRateLimiter(config, logger),
    logger,
    clock,
  };
}

function createRateLimiter(config: Config, logger: Logger): RateLimiter {
  switch (config.rateLimitBackend) {
    case 'memory':
      return createMemoryRateLimiter(config.rateLimitPerMinute);
    case 'dynamodb': {
      const tableName = config.rateLimitTable;
      // parseConfig refuses this combination, but its refinement does not narrow the type.
      if (tableName === undefined) {
        throw new Error('RATE_LIMIT_TABLE is required when RATE_LIMIT_BACKEND is dynamodb.');
      }
      return createDynamoDbRateLimiter({
        client: new DynamoDBClient({}),
        tableName,
        limit: config.rateLimitPerMinute,
        logger,
      });
    }
  }
}
