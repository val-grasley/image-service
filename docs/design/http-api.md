# Design: HTTP API

Implements `docs/architecture.md` sections 4 and 7. Directory: `apps/api/src/http/`, plus
`app.ts`, `errors.ts`, and `operations/`. The SDK (`design/sdk.md`) owns the public types.

## Assembly

```ts
type AppDeps = OperationDeps & {   // OperationDeps is defined in operations/ (design/caching.md)
  rateLimiter: RateLimiter;
  logger: Logger;
  clock: Clock;
};

function createApp(config: Config, deps: AppDeps): OpenAPIHono;
function defaultDeps(config: Config): AppDeps;
```

`app.ts` holds both. `server.ts` and `lambda.ts` call `createApp(loadConfig(), defaultDeps(config))`.
Tests call `createApp(testConfig(overrides), deps)` with the fake upstream's address in
`ALLOWED_HOSTS` and otherwise real collaborators; the only substitutions tests make are
the clock, the DynamoDB client, and (for a few pipeline tests) a recording wrapper around
the pipeline.

## Errors

`apps/api/src/errors.ts`:

```ts
class ServiceError extends Error {
  readonly code: ErrorCode;             // SDK union
  readonly detail: string;
  readonly fields?: { field: string; message: string }[];
  readonly upstreamStatus?: number;
  readonly rateLimit?: RateLimitDecision;
  constructor(code, detail, extra?, options?: { cause?: unknown });
}
```

Domain modules throw `ServiceError`. `http/errors.ts` owns the mapping:

```ts
const STATUS: Record<ErrorCode, { status: number; title: string }>;
function toProblem(err: unknown, requestId: string): { status; body: ProblemDetails; headers };
```

The table is exactly section 7's. Unknown errors become `internal_error` with the generic
title and no detail, logged at `error` with the stack and `cause` chain. Every problem
response carries `Content-Type: application/problem+json`, `Cache-Control: no-store`,
`X-Request-Id`, and the CORS headers; 429 adds the rate-limit headers; 405 adds `Allow`.

`type` is `/docs#error-<code>`. The body is the `ProblemDetails` type from the SDK.

Validation failures from the route schema are turned into `ServiceError('invalid_parameter')`
with `fields` built from the Zod issues: `field` is the parameter name, `message` is a
sentence saying what is accepted (`must be an integer between 1 and 4096`).

## Routes

Each route is a `createRoute` definition and a handler in its own file under `http/routes/`.

**`GET /process`, `HEAD /process`.** Query schema:

| Field | Schema |
|---|---|
| `url` | `z.url()`; stays a string in the schema's output so the type lock holds, and `toSpec` parses it |
| `width`, `height` | `z.coerce.number().int().min(1).max(MAX_OUTPUT_DIMENSION).optional()` |
| `crop` | `z.enum(['fit', 'fill', 'scale', 'pad']).optional()` |
| `format` | `z.enum(['jpeg', 'png', 'webp', 'avif']).optional()` |
| `quality` | `z.coerce.number().int().min(1).max(100).optional()` |

A cross-field refinement rejects `width * height > MAX_OUTPUT_PIXELS` with a message on
`width`. `MAX_*` come from config, so the schema is built by a function of config inside
`createApp`.

**Type lock against the SDK.** `z.ZodType<Params>` only checks assignability, which misses an
omitted optional field. A type test beside the schema asserts equality:

```ts
type Normalize<T> = { [K in keyof T]: Exclude<T[K], undefined> };
expectTypeOf<Normalize<z.output<typeof processQuery>>>().toEqualTypeOf<Normalize<ProcessParams>>();
```

`Normalize` strips only the `| undefined` that Zod adds to optional outputs and keeps the
optional modifier, so an omitted field, an extra field, a wrong type, and a field made
required all fail. The assertion lives in `process-query.test.ts` using Vitest's
`expectTypeOf`, which is checked by `tsc -b` because test files are in the typecheck
project. The `/info` response schema is locked to the SDK's `SourceInfo` the same way.

Both operations begin by calling `checkUrl(spec.url, undefined, policy)` and throwing its
denial, so the URL rules run before any cache lookup or network activity, as section 4
step 4 requires.

The handler: parses `If-None-Match` into a list; calls `processImage`; on `image` builds
the response with the headers in section 7 and the body (omitted for HEAD); on
`not_modified` responds 304 with `ETag`, `Cache-Control`, `X-Request-Id`.

**`GET /info`.** Same `url` schema only. Calls `describeSource`, which fetches (through the
source cache), sniffs, and inspects. Responds with JSON
`{ url, finalUrl, format, width, height, bytes, pages }`, where `format` is the sniffed
`SourceType`, and `Cache-Control: public, max-age=<SOURCE_CACHE_TTL_SECONDS>`.

**`GET /health`.** `{ status: 'ok', version }` from the package version baked in at build,
`Cache-Control: no-store`. No dependencies are checked; the function is healthy if it can
answer.

**`GET /openapi.json`, `GET /docs`.** Section "OpenAPI" below.

**Unknown path**: `app.notFound` throws `not_found`. **Unsupported method on a known path**:
after each route's method handlers, `app.all(path, ...)` throws `method_not_allowed` with
the `Allow` list for that path. Hono dispatches HEAD to the GET handler and returns its
status and headers with no body, so HEAD is not registered separately.

## Middleware, in order

1. `request-id`: validates or generates `X-Request-Id`, sets it on the context and on the
   response, creates the per-request child logger.
2. `cors`: `hono/cors` with origin `*`, methods `GET, HEAD`, and `exposeHeaders` set to
   exactly `ETag`, `X-Request-Id`, `X-Image-Width`, `X-Image-Height`, `X-Image-Format`,
   `X-Result-Cache`, `Retry-After`, `RateLimit`, `RateLimit-Policy`. `ETag` is listed
   because it is not CORS-safelisted and the SDK reads it.
3. `loop-guard`: refuses `X-Image-Service-Fetch` with `url_not_allowed`.
4. `rate-limit`: `design/rate-limiting.md`, on `/process` and `/info` only. Runs before
   validation so invalid requests count. `/health`, the documentation routes, and unknown
   paths are not limited.
5. Route handlers.
6. `app.onError`: `toProblem`.
7. A final response hook sets `Cache-Control` for any route that did not set it, to
   `no-store`, so a forgotten header fails safe.

A request log line is written when the response is complete: `requestId`, `method`, `path`
(no query), `status`, `durationMs`, `code` if error, `resultCache` if image, source
`hostname` if any.

## OpenAPI

`http/openapi.ts` calls `app.doc31('/openapi.json', { openapi: '3.1.0', info: { title, version }, servers: [] })`
and registers the shared `ProblemDetails` schema and one response component per error code
so each route lists exactly the codes it can produce. `/docs` is a small HTML page assembled
in the route file: a heading, an "Errors" section with one `<section id="error-<code>">`
per code giving status, title, and a sentence, and the Swagger UI component from
`@hono/swagger-ui` pointed at `/openapi.json`. Both carry `Cache-Control: public, max-age=3600`.

## Tests

`apps/api/test/`:

- `process.test.ts`: the three example requests from the brief against the fake upstream;
  every response header in section 7 present with correct values; HEAD matches GET headers
  with an empty body; each validation failure returns 400 with the field named and a
  sentence; `width * height` over the pixel cap is a `width` field error; a 304 round trip
  using the returned `ETag`.
- `info.test.ts`: metadata for each format; the same errors as `/process` for bad URLs.
- `errors.test.ts`: table of every `ErrorCode` through `toProblem` asserting status, title,
  content type, `no-store`, `type`; an unknown `Error` becomes `internal_error` with no
  detail; a `ServiceError` with `cause` logs the chain; no `detail` contains a filesystem
  path, a stack frame, or an upstream response body (a hostname or a blocked address the
  caller caused is fine).
- `cache-control.test.ts`: every route, including `/openapi.json`, `/docs`, an unknown
  path, and a wrong method, carries the `Cache-Control` value section 7 assigns it.
- `routing.test.ts`: unknown path is 404 problem; `POST /process` is 405 with `Allow`;
  `/health` shape and `no-store`; `/openapi.json` lists the three paths and every parameter;
  `/docs` contains an anchor for every error code.
- `middleware.test.ts`: request-id accepted when valid, regenerated when not; the loop
  marker is refused; CORS headers present on 200, 304, and error responses.
