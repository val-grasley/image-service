import {
  ERROR_CODES,
  ImageApiError,
  ImageApiTransportError,
  type ProblemDetails,
} from './errors.ts';
import {
  OUTPUT_FORMATS,
  infoUrl,
  processUrl,
  type OutputFormat,
  type ProcessParams,
} from './transform.ts';

const SOURCE_TYPES = ['jpeg', 'png', 'webp', 'gif', 'avif', 'tiff'] as const;

/** A source image type the service accepts and `/info` reports. */
export type SourceType = (typeof SOURCE_TYPES)[number];

/** The `GET /info` response: metadata of the source image, read without transforming it. */
export type SourceInfo = {
  /** The URL as requested. */
  url: string;
  /** The URL after redirects. */
  finalUrl: string;
  /** The type detected from the bytes; the upstream `Content-Type` is not trusted. */
  format: SourceType;
  width: number;
  height: number;
  /** Size of the source in bytes. */
  bytes: number;
  /** Frame or page count; `/process` uses the first. */
  pages: number;
};

/** A transformed image from `GET /process`, with the metadata the service sent in its headers. */
export type ProcessResult = {
  /** The encoded image, as received. Its length is the file size. */
  bytes: Uint8Array;
  /** The `Content-Type` of the image, such as `image/webp`. */
  contentType: string;
  /** The output encoding, from `X-Image-Format`. */
  format: OutputFormat;
  /** Width in pixels after EXIF orientation. */
  width: number;
  /** Height in pixels after EXIF orientation. */
  height: number;
  /** The strong `ETag` of the result, usable in `If-None-Match`. */
  etag: string;
  /** The `X-Request-Id` of the request that produced the image. */
  requestId: string;
  /**
   * Whether the service's in-process result cache answered, from `X-Result-Cache`. It says
   * nothing about the CDN, which reports its own hits in `X-Cache`.
   */
  resultCache: 'hit' | 'miss';
};

const DETAIL_LIMIT = 200;
const PROBLEM_JSON = /^application\/problem\+json\s*(?:;|$)/i;

/**
 * A client for the image service. Errors arrive typed: {@link ImageApiError} when the service
 * answered, {@link ImageApiTransportError} when no complete response arrived.
 */
export class ImageClient {
  readonly #baseUrl: string | URL;
  readonly #fetch: typeof fetch;

  /**
   * @param baseUrl The service's address. Any path on it is replaced by the endpoint path.
   * @param options.fetch The `fetch` that sends every request, such as one with a custom agent
   *   in Node. Defaults to `globalThis.fetch`.
   */
  constructor(baseUrl: string | URL, options: { fetch?: typeof fetch } = {}) {
    this.#baseUrl = baseUrl;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /**
   * Requests the canonical `GET /process` URL for `params` and returns the image with its
   * metadata.
   *
   * @throws {ImageApiError} When the service answers with an error status, or answers 2xx
   *   without a valid image header (code `internal_error`, the response's status).
   * @throws {ImageApiTransportError} When no complete response arrives, including when
   *   `signal` aborts the request.
   */
  async process(
    params: ProcessParams,
    options: { signal?: AbortSignal } = {},
  ): Promise<ProcessResult> {
    const { response, body } = await this.#receive(
      processUrl(this.#baseUrl, params),
      options.signal,
    );
    return {
      bytes: body,
      contentType: header(response, 'Content-Type', (value) => value),
      format: header(response, 'X-Image-Format', (value) =>
        OUTPUT_FORMATS.find((format) => format === value),
      ),
      width: header(response, 'X-Image-Width', dimension),
      height: header(response, 'X-Image-Height', dimension),
      etag: header(response, 'ETag', (value) => value),
      requestId: header(response, 'X-Request-Id', (value) => value),
      resultCache: header(response, 'X-Result-Cache', (value) =>
        value === 'hit' || value === 'miss' ? value : undefined,
      ),
    };
  }

  /**
   * Requests `GET /info` for a source image and returns its metadata.
   *
   * @throws {ImageApiError} When the service answers with an error status, or answers 2xx
   *   with a body that is not a {@link SourceInfo} (code `internal_error`, the response's
   *   status).
   * @throws {ImageApiTransportError} When no complete response arrives, including when
   *   `signal` aborts the request.
   */
  async info(sourceUrl: string, options: { signal?: AbortSignal } = {}): Promise<SourceInfo> {
    const { response, body } = await this.#receive(
      infoUrl(this.#baseUrl, sourceUrl),
      options.signal,
    );
    let info: unknown;
    try {
      info = JSON.parse(new TextDecoder().decode(body));
    } catch (error) {
      throw new ImageApiError(synthesizedProblem(response, 'The response body is not JSON.'), {
        cause: error,
      });
    }
    if (!isSourceInfo(info)) {
      throw new ImageApiError(
        synthesizedProblem(response, 'The response body is not a SourceInfo.'),
      );
    }
    return info;
  }

  async #receive(
    url: URL,
    signal: AbortSignal | undefined,
  ): Promise<{ response: Response; body: Uint8Array }> {
    // Called detached: a browser's fetch throws "Illegal invocation" when its receiver is not
    // the global object, and `this.#fetch(...)` would make the client its receiver.
    const send = this.#fetch;
    let response: Response;
    let body: Uint8Array;
    try {
      response = await send(url, { signal: signal ?? null });
      body = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw new ImageApiTransportError('The request to the image service failed.', {
        cause: error,
      });
    }
    if (!response.ok) throw errorFor(response, new TextDecoder().decode(body));
    return { response, body };
  }
}

function errorFor(response: Response, text: string): ImageApiError {
  const fallback = synthesizedProblem(response, text.slice(0, DETAIL_LIMIT));
  if (!PROBLEM_JSON.test(response.headers.get('Content-Type') ?? '')) {
    return new ImageApiError(fallback);
  }
  let problem: unknown;
  try {
    problem = JSON.parse(text);
  } catch (error) {
    return new ImageApiError(fallback, { cause: error });
  }
  return new ImageApiError(isProblem(problem) ? problem : fallback);
}

function synthesizedProblem(response: Response, detail: string): ProblemDetails {
  return {
    type: '/docs#error-internal_error',
    title: 'Internal error',
    status: response.status,
    detail,
    code: 'internal_error',
    requestId: response.headers.get('X-Request-Id') ?? '',
  };
}

function header<T>(response: Response, name: string, parse: (value: string) => T | undefined): T {
  const raw = response.headers.get(name);
  const value = raw === null || raw === '' ? undefined : parse(raw);
  if (value === undefined) {
    throw new ImageApiError(
      synthesizedProblem(response, `The response has no valid ${name} header.`),
    );
  }
  return value;
}

function dimension(value: string): number | undefined {
  return /^[1-9]\d*$/.test(value) ? Number(value) : undefined;
}

function isProblem(body: unknown): body is ProblemDetails {
  return (
    typeof body === 'object' &&
    body !== null &&
    'type' in body &&
    typeof body.type === 'string' &&
    'title' in body &&
    typeof body.title === 'string' &&
    'status' in body &&
    typeof body.status === 'number' &&
    'detail' in body &&
    typeof body.detail === 'string' &&
    'code' in body &&
    ERROR_CODES.some((code) => code === body.code) &&
    'requestId' in body &&
    typeof body.requestId === 'string' &&
    (!('errors' in body) || (Array.isArray(body.errors) && body.errors.every(isFieldError))) &&
    (!('upstreamStatus' in body) || typeof body.upstreamStatus === 'number')
  );
}

function isFieldError(entry: unknown): boolean {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'field' in entry &&
    typeof entry.field === 'string' &&
    'message' in entry &&
    typeof entry.message === 'string'
  );
}

function isSourceInfo(body: unknown): body is SourceInfo {
  return (
    typeof body === 'object' &&
    body !== null &&
    'url' in body &&
    typeof body.url === 'string' &&
    'finalUrl' in body &&
    typeof body.finalUrl === 'string' &&
    'format' in body &&
    SOURCE_TYPES.some((type) => type === body.format) &&
    'width' in body &&
    typeof body.width === 'number' &&
    'height' in body &&
    typeof body.height === 'number' &&
    'bytes' in body &&
    typeof body.bytes === 'number' &&
    'pages' in body &&
    typeof body.pages === 'number'
  );
}
