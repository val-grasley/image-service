import { z } from 'zod';

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const nonNegativeInt = (fallback: number) =>
  z.coerce.number().int().nonnegative().default(fallback);

const hostList = z
  .string()
  .default('')
  .transform(
    (raw): ReadonlySet<string> =>
      new Set(
        raw
          .split(',')
          // Hostnames compare without one trailing dot (architecture section 5), so it is
          // removed from the host part here, before any :port.
          .map((entry) =>
            entry
              .trim()
              .toLowerCase()
              .replace(/\.(:\d+)?$/, '$1'),
          )
          .filter((entry) => entry.length > 0),
      ),
  );

const configSchema = z
  .object({
    MAX_SOURCE_BYTES: positiveInt(15_000_000),
    MAX_INPUT_PIXELS: positiveInt(50_000_000),
    FETCH_CONNECT_TIMEOUT_MS: positiveInt(3000),
    FETCH_TOTAL_TIMEOUT_MS: positiveInt(8000),
    MAX_REDIRECTS: nonNegativeInt(3),
    TRANSFORM_TIMEOUT_SECONDS: positiveInt(5),
    MAX_OUTPUT_DIMENSION: positiveInt(4096),
    MAX_OUTPUT_PIXELS: positiveInt(16_000_000),
    MAX_AVIF_OUTPUT_PIXELS: positiveInt(8_000_000),
    MAX_OUTPUT_BYTES: positiveInt(10_000_000),
    DEFAULT_QUALITY: z.coerce.number().int().min(1).max(100).default(80),
    RESULT_CACHE_TTL_SECONDS: positiveInt(3600),
    RESULT_CACHE_MAX_BYTES: positiveInt(100_000_000),
    SOURCE_CACHE_TTL_SECONDS: positiveInt(300),
    SOURCE_CACHE_MAX_BYTES: positiveInt(50_000_000),
    RATE_LIMIT_PER_MINUTE: positiveInt(60),
    RATE_LIMIT_BACKEND: z.enum(['memory', 'dynamodb']).default('memory'),
    RATE_LIMIT_TABLE: z.string().min(1).optional(),
    CLIENT_IP_SOURCE: z.enum(['socket', 'x-forwarded-for', 'cloudfront']).default('socket'),
    TRUSTED_PROXY_COUNT: nonNegativeInt(0),
    PUBLIC_HOSTS: hostList,
    ALLOWED_HOSTS: hostList,
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    PORT: positiveInt(3000),
  })
  .refine((env) => env.RATE_LIMIT_BACKEND !== 'dynamodb' || env.RATE_LIMIT_TABLE !== undefined, {
    message: 'required when RATE_LIMIT_BACKEND is dynamodb',
    path: ['RATE_LIMIT_TABLE'],
  })
  .transform((e) => ({
    maxSourceBytes: e.MAX_SOURCE_BYTES,
    maxInputPixels: e.MAX_INPUT_PIXELS,
    fetchConnectTimeoutMs: e.FETCH_CONNECT_TIMEOUT_MS,
    fetchTotalTimeoutMs: e.FETCH_TOTAL_TIMEOUT_MS,
    maxRedirects: e.MAX_REDIRECTS,
    transformTimeoutSeconds: e.TRANSFORM_TIMEOUT_SECONDS,
    maxOutputDimension: e.MAX_OUTPUT_DIMENSION,
    maxOutputPixels: e.MAX_OUTPUT_PIXELS,
    maxAvifOutputPixels: e.MAX_AVIF_OUTPUT_PIXELS,
    maxOutputBytes: e.MAX_OUTPUT_BYTES,
    defaultQuality: e.DEFAULT_QUALITY,
    resultCacheTtlSeconds: e.RESULT_CACHE_TTL_SECONDS,
    resultCacheMaxBytes: e.RESULT_CACHE_MAX_BYTES,
    sourceCacheTtlSeconds: e.SOURCE_CACHE_TTL_SECONDS,
    sourceCacheMaxBytes: e.SOURCE_CACHE_MAX_BYTES,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    rateLimitBackend: e.RATE_LIMIT_BACKEND,
    rateLimitTable: e.RATE_LIMIT_TABLE,
    clientIpSource: e.CLIENT_IP_SOURCE,
    trustedProxyCount: e.TRUSTED_PROXY_COUNT,
    publicHosts: e.PUBLIC_HOSTS,
    allowedHosts: e.ALLOWED_HOSTS,
    logLevel: e.LOG_LEVEL,
    port: e.PORT,
  }));

export type Config = Readonly<z.output<typeof configSchema>>;
export type LogLevel = Config['logLevel'];

export class ConfigError extends Error {
  constructor(error: z.ZodError) {
    const lines = error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    super(`Invalid configuration:\n${lines.join('\n')}`, { cause: error });
    this.name = 'ConfigError';
  }
}

export function parseConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error);
  }
  return parsed.data;
}

export function loadConfig(): Config {
  return parseConfig(process.env);
}
