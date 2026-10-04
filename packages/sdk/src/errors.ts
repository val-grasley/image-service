/**
 * The stable machine-readable code carried by every error response. Each code maps to exactly
 * one HTTP status; the service's `/docs#error-<code>` section describes it.
 */
export type ErrorCode =
  | 'invalid_parameter'
  | 'url_not_allowed'
  | 'source_too_large'
  | 'unsupported_source_type'
  | 'output_too_large'
  | 'rate_limited'
  | 'upstream_error'
  | 'too_many_redirects'
  | 'upstream_timeout'
  | 'transform_timeout'
  | 'not_found'
  | 'method_not_allowed'
  | 'internal_error';

/** An RFC 9457 problem-details body as the service sends it with `application/problem+json`. */
export type ProblemDetails = {
  /** Relative reference to the code's documentation, `/docs#error-<code>`. */
  type: string;
  title: string;
  status: number;
  detail: string;
  code: ErrorCode;
  /** The `X-Request-Id` of the request that failed, for correlating with service logs. */
  requestId: string;
  /** Present on `invalid_parameter`: one entry per rejected query parameter. */
  errors?: { field: string; message: string }[];
  /** Present on `upstream_error` when the source server answered with a non-2xx status. */
  upstreamStatus?: number;
};

/** Thrown when the service answers with an error status. The parsed body is `problem`. */
export class ImageApiError extends Error {
  override name = 'ImageApiError';

  /** The problem-details body, or one synthesized from a non-problem error response. */
  readonly problem: ProblemDetails;

  /** Wraps a problem-details body; the message is its `detail`, or its `title` when empty. */
  constructor(problem: ProblemDetails, options?: { cause?: unknown }) {
    super(problem.detail === '' ? problem.title : problem.detail, options);
    this.problem = problem;
  }

  /** The stable error code, for branching on the kind of failure. */
  get code(): ErrorCode {
    return this.problem.code;
  }

  /** The HTTP status of the response. */
  get status(): number {
    return this.problem.status;
  }

  /** The request ID to quote when reporting the failure; empty if the response had none. */
  get requestId(): string {
    return this.problem.requestId;
  }
}

/** Thrown when no response arrived at all, such as a network failure; the cause is attached. */
export class ImageApiTransportError extends Error {
  override name = 'ImageApiTransportError';
}
