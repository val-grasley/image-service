import type { ErrorCode, ProblemDetails } from '@image-service/sdk';

type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
};

export class ServiceError extends Error {
  override name = 'ServiceError';
  readonly code: ErrorCode;
  readonly detail: string;
  readonly fields?: NonNullable<ProblemDetails['errors']>;
  readonly upstreamStatus?: number;
  readonly rateLimit?: RateLimitDecision;

  constructor(
    code: ErrorCode,
    detail: string,
    extra: Pick<ServiceError, 'fields' | 'upstreamStatus' | 'rateLimit'> = {},
    options?: { cause?: unknown },
  ) {
    super(detail, options);
    this.code = code;
    this.detail = detail;
    if (extra.fields !== undefined) this.fields = extra.fields;
    if (extra.upstreamStatus !== undefined) this.upstreamStatus = extra.upstreamStatus;
    if (extra.rateLimit !== undefined) this.rateLimit = extra.rateLimit;
  }
}
