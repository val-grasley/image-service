import type { ErrorCode, ProblemDetails } from '@image-service/sdk';
import type { RateLimitDecision } from './rate-limit/limiter.ts';

export class ServiceError extends Error {
  override name = 'ServiceError';
  readonly code: ErrorCode;
  readonly detail: string;
  readonly fields?: NonNullable<ProblemDetails['errors']>;
  readonly upstreamStatus?: number;
  readonly rateLimit?: RateLimitDecision;
  readonly allow?: readonly string[];

  constructor(
    code: ErrorCode,
    detail: string,
    extra: Pick<ServiceError, 'fields' | 'upstreamStatus' | 'rateLimit' | 'allow'> = {},
    options?: { cause?: unknown },
  ) {
    super(detail, options);
    this.code = code;
    this.detail = detail;
    if (extra.fields !== undefined) this.fields = extra.fields;
    if (extra.upstreamStatus !== undefined) this.upstreamStatus = extra.upstreamStatus;
    if (extra.rateLimit !== undefined) this.rateLimit = extra.rateLimit;
    if (extra.allow !== undefined) this.allow = extra.allow;
  }
}
