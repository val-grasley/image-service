import type { ErrorCode, ProblemDetails } from '@image-service/sdk';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ZodError } from 'zod';
import { ServiceError } from '../errors.ts';
import { WINDOW_MS } from '../rate-limit/limiter.ts';

export const STATUS: Record<ErrorCode, { status: ContentfulStatusCode; title: string }> = {
  invalid_parameter: { status: 400, title: 'Invalid parameter' },
  url_not_allowed: { status: 403, title: 'URL not allowed' },
  not_found: { status: 404, title: 'Not found' },
  method_not_allowed: { status: 405, title: 'Method not allowed' },
  source_too_large: { status: 413, title: 'Source too large' },
  unsupported_source_type: { status: 415, title: 'Unsupported source type' },
  output_too_large: { status: 422, title: 'Output too large' },
  rate_limited: { status: 429, title: 'Rate limited' },
  internal_error: { status: 500, title: 'Internal error' },
  transform_timeout: { status: 500, title: 'Transform timeout' },
  upstream_error: { status: 502, title: 'Upstream error' },
  too_many_redirects: { status: 502, title: 'Too many redirects' },
  upstream_timeout: { status: 504, title: 'Upstream timeout' },
};

export const ERROR_CODES = Object.keys(STATUS).filter((key): key is ErrorCode =>
  Object.hasOwn(STATUS, key),
);

type Problem = {
  status: ContentfulStatusCode;
  body: ProblemDetails;
  headers: Record<string, string>;
};

export function toProblem(err: unknown, requestId: string): Problem {
  // Anything that is not a ServiceError is unexpected, and its message may carry internals.
  const error = err instanceof ServiceError ? err : undefined;
  const code = error?.code ?? 'internal_error';
  const { status, title } = STATUS[code];
  const body: ProblemDetails = {
    type: `/docs#error-${code}`,
    title,
    status,
    detail: error?.detail ?? '',
    code,
    requestId,
    ...(error?.fields !== undefined && { errors: error.fields }),
    ...(error?.upstreamStatus !== undefined && { upstreamStatus: error.upstreamStatus }),
  };
  const headers: Record<string, string> = {
    'Content-Type': 'application/problem+json',
    'Cache-Control': 'no-store',
    'X-Request-Id': requestId,
  };
  if (error?.rateLimit !== undefined) {
    const { limit, remaining, resetSeconds } = error.rateLimit;
    headers['Retry-After'] = String(resetSeconds);
    headers.RateLimit = `"default";r=${String(remaining)};t=${String(resetSeconds)}`;
    headers['RateLimit-Policy'] = `"default";q=${String(limit)};w=${String(WINDOW_MS / 1000)}`;
  }
  if (error?.allow !== undefined) {
    headers.Allow = error.allow.join(', ');
  }
  return { status, body, headers };
}

export function invalidParameters(error: ZodError): ServiceError {
  const fields: { field: string; message: string }[] = [];
  for (const issue of error.issues) {
    // One unrecognized_keys issue names every unknown parameter at the object's own path.
    const paths =
      issue.code === 'unrecognized_keys'
        ? issue.keys.map((key) => [...issue.path, key])
        : [issue.path];
    for (const path of paths) {
      const field = path.map(String).join('.');
      if (!fields.some((existing) => existing.field === field)) {
        fields.push({ field, message: issue.message });
      }
    }
  }
  const names = fields.map(({ field }) => field).join(', ');
  return new ServiceError('invalid_parameter', `Invalid query parameters: ${names}.`, { fields });
}
