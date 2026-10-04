# Design: SDK

`packages/sdk`, published name `@image-service/sdk`. Dependency-free, ESM, runs in browsers
and Node 24. It owns the public contract's types, builds canonical request URLs, and wraps
`fetch` with typed results and errors. The UI consumes it; the API's schemas are typed
against it (`design/http-api.md`).

## Surface

```ts
// transform.ts
export type CropMode = 'fit' | 'fill' | 'scale' | 'pad';
export type OutputFormat = 'jpeg' | 'png' | 'webp' | 'avif';
export type ProcessParams = {
  url: string;
  width?: number;
  height?: number;
  crop?: CropMode;
  format?: OutputFormat;
  quality?: number;
};
export const CROP_MODES: readonly CropMode[];
export const OUTPUT_FORMATS: readonly OutputFormat[];
export function processUrl(baseUrl: string | URL, params: ProcessParams): URL;
export function infoUrl(baseUrl: string | URL, sourceUrl: string): URL;
export function curlFor(url: URL): string;

// errors.ts
export type ErrorCode = 'invalid_parameter' | 'url_not_allowed' | 'source_too_large'
  | 'unsupported_source_type' | 'output_too_large' | 'rate_limited' | 'upstream_error'
  | 'too_many_redirects' | 'upstream_timeout' | 'transform_timeout' | 'not_found'
  | 'method_not_allowed' | 'internal_error';
export type ProblemDetails = {
  type: string; title: string; status: number; detail: string; code: ErrorCode;
  requestId: string;
  errors?: { field: string; message: string }[];
  upstreamStatus?: number;
};
export class ImageApiError extends Error {
  readonly problem: ProblemDetails;
  get code(): ErrorCode; get status(): number; get requestId(): string;
}
export class ImageApiTransportError extends Error {}   // fetch failed, no response

// client.ts
export type ProcessResult = {
  bytes: Uint8Array; contentType: string; format: OutputFormat;
  width: number; height: number; etag: string; requestId: string; resultCache: 'hit' | 'miss';
};
export type SourceType = 'jpeg' | 'png' | 'webp' | 'gif' | 'avif' | 'tiff';
export type SourceInfo = { url: string; finalUrl: string; format: SourceType; width: number; height: number; bytes: number; pages: number };
export class ImageClient {
  constructor(baseUrl: string | URL, options?: { fetch?: typeof fetch });
  process(params: ProcessParams, options?: { signal?: AbortSignal }): Promise<ProcessResult>;
  info(sourceUrl: string, options?: { signal?: AbortSignal }): Promise<SourceInfo>;
}
```

`index.ts` re-exports exactly these. Every exported symbol carries a doc comment; this is
the one place in the repository where that is required.

## Canonical URLs

`processUrl` emits query parameters in the fixed order `url, width, height, crop, format,
quality`, omits undefined ones, and does not add defaults. The endpoint path replaces any
path on `baseUrl`, so `https://host/api/` and `https://host/` both yield `/process`. Two calls with the same
parameters produce byte-identical URLs regardless of the object's key order, which is what
gives SDK users shared CloudFront cache entries (decision 11). It performs no range
validation; the API does, and the error comes back typed.

`curlFor` produces `curl -sS -D - -o out.<format> '<url>'`, or `-o out` when `format` is
absent, with the URL single-quoted and any single quote escaped.

## Client behavior

- `process`: `fetch(url, { signal })`. A non-2xx response with `application/problem+json`
  throws `ImageApiError`. A non-2xx response with any other body (a Lambda throttle, a
  proxy error) throws `ImageApiError` with a synthesized problem: code `internal_error`,
  the status, `detail` from the body text truncated to 200 characters, `requestId` from the
  header or empty. A network failure throws `ImageApiTransportError` with `cause`.
- Metadata comes from the `X-Image-*` headers; `bytes` from `arrayBuffer()`; `resultCache`
  from `X-Result-Cache`.
- `info`: same error handling; the JSON body is returned as `SourceInfo` without
  re-validation (the API is the trusted party).
- The injectable `fetch` exists for tests and for Node users with a custom agent; it
  defaults to `globalThis.fetch`.

## Build

`tsc` emits ESM to `dist/` with declarations. `package.json` has `"type": "module"`,
`exports` pointing at `dist/index.js` and `dist/index.d.ts`, and `files: ["dist"]`. No
bundler.

## Tests

`transform.test.ts`: a table of parameter objects, in varied key orders, with the expected
URL string; omission of undefined; `curlFor` quoting. `client.test.ts`: an injected `fetch`
returning crafted responses for each branch above (problem JSON, non-problem 429 text,
network rejection, success with headers), asserting the thrown class, `code`, `status`, and
the parsed result.
