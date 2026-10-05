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

function createApp(config: Config, deps: AppDeps, serviceVersion: string): OpenAPIHono;
function defaultDeps(config: Config, serviceVersion: string): AppDeps;
```

`app.ts` holds both. `server.ts` and `lambda.ts` call
`createApp(loadConfig(), defaultDeps(config, version), version)`, each obtaining `version`
as its runtime allows (decision 44); `app.ts` does no file I/O.
Tests call `createApp(testConfig(overrides), deps, version)` with the fake upstream's address
in `ALLOWED_HOSTS`, a literal version, and otherwise real collaborators; the only
substitutions tests make are the clock, the DynamoDB client, (for a few pipeline tests) a
recording wrapper around the pipeline, and (to show the URL rules run before any cache
lookup) a shared cache instance passed to two apps with different `ALLOWED_HOSTS`. Tests
pass an empty environment to `app.request()`, or one carrying
`incoming.socket.remoteAddress`, since the rate limiter reads `c.env`, which `app.request()`
otherwise leaves undefined.

`server.ts` serves `/`, `/index.html`, `/favicon.ico`, and `/assets/*` from `apps/web/dist`
with `Cache-Control: no-cache` when that directory exists, mirroring the CloudFront
behaviors, and hands every other request, and any file not found there, to the app.

## Errors

`apps/api/src/errors.ts`:

```ts
class ServiceError extends Error {
  readonly code: ErrorCode;             // SDK union
  readonly detail: string;
  readonly fields?: { field: string; message: string }[];
  readonly upstreamStatus?: number;
  readonly rateLimit?: RateLimitDecision;
  readonly allow?: readonly string[];     // the Allow list of a 405 (decision 43)
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

Validation failures from the route schema are turned into
`ServiceError('invalid_parameter')` with `fields` built from the Zod issues: `field` is the
parameter name, `message` is a sentence saying what is accepted (`must be an integer between
1 and 4096, written as digits without a sign or leading zeros`). Both query schemas are
strict, so a parameter the route does not define fails validation: Zod reports every unknown
key in one `unrecognized_keys` issue whose `keys` lists them, and the hook writes one entry
per key, with the message set on the schema and built from its keys (`not accepted; use url,
width, height, crop, format, quality`; decision 61). A repeated key reaches the schema as an
array, so it fails as that parameter's own error, or once as unknown.

## Routes

Each route is a `createRoute` definition and a handler in its own file under `http/routes/`.

**`GET /process`, `HEAD /process`.** Query schema, a `z.strictObject`:

| Field | Schema |
|---|---|
| `url` | `z.url()`; stays a string in the schema's output so the type lock holds, and `toSpec` parses it |
| `width`, `height` | `integer(1, MAX_OUTPUT_DIMENSION)`: see below |
| `crop` | `z.enum(['fit', 'fill', 'scale', 'pad']).optional()` |
| `format` | `z.enum(['jpeg', 'png', 'webp', 'avif']).optional()` |
| `quality` | `integer(1, 100)` |

`integer(min, max)` is `z.preprocess` into `z.number().int().min(min).max(max)`, then
`.optional()`. The preprocess turns a string into a number only when it matches
`^(0|[1-9]\d*)$`, and leaves anything else a string for the number check to refuse, so
`05`, `5.0`, `0x5`, `5e0`, `+5`, and ` 5` fail with the parameter's one message
(`must be an integer between 1 and 1024, written as digits without a sign or leading
zeros`) instead of each becoming a cache key for the same result (decision 63).
zod-to-openapi documents a preprocess by its output schema, so the document still shows
`type: integer` with the same `minimum` and `maximum`.

A cross-field refinement rejects `width * height > MAX_OUTPUT_PIXELS` with a message on
`width`. These 400s cover only the requested dimensions. The pipeline checks the computed
output too: an output larger than the source on either axis must fit `MAX_OUTPUT_DIMENSION`
and `MAX_OUTPUT_PIXELS`, else 422 `output_too_large` (decision 68). `MAX_*` come from
config, so the schema is built by a function of config inside `createApp`.

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
`not_modified` responds 304 with `ETag`, `Cache-Control`, `X-Request-Id`. The image
response also sets `Content-Length` from the byte length, so HEAD carries it; the adapter
passes it to Lambda, and whether the streaming invoke keeps it is to be confirmed on the
first deploy (`design/infrastructure.md`, "Lambda entry"); clients measure size from the body
regardless (section 7).

Each validation message is set on its Zod check (`{ error }`), and the cross-field
refinement carries its own, so the default hook copies `issue.message` into `fields`, one
entry per parameter (an `unrecognized_keys` issue gives one entry per key; see "Errors").
The query schema's output types an omitted field as `T | undefined`, so `toSpec` accepts
that shape as well as `ProcessParams` (decision 45).

**`GET /info`.** Same `url` schema only, also strict. Calls `describeSource`, which fetches
(through the source cache), sniffs, and inspects. Responds with JSON
`{ url, finalUrl, format, width, height, bytes, pages }`, where `format` is the sniffed
`SourceType`, and `Cache-Control: public, max-age=<SOURCE_CACHE_TTL_SECONDS>`.

**`GET /health`.** `{ status: 'ok', version }` from the service version the entry passes to
`createApp` (decision 44), `Cache-Control: no-store`. No dependencies are checked; the
function is healthy if it can answer.

**`GET /openapi.json`, `GET /docs`.** Section "OpenAPI" below.

**Unknown path**: `app.notFound` throws `not_found`. **Unsupported method on a known path**:
after each route's method handlers, `app.all(path, ...)` throws `method_not_allowed` with
the `Allow` list for that path. The list is derived from the routes registered on the app,
plus HEAD wherever GET is registered, and travels on `ServiceError` as `allow`, from which
`toProblem` writes the header (decision 43). Hono dispatches HEAD to the GET handler and returns its
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
`hostname` if any. The `request-id` middleware writes it after `next()`, from context
variables the route handlers and `onError` set; a 5xx line is at `error` with the error.

## OpenAPI

`http/openapi.ts` calls `app.doc31('/openapi.json', { openapi: '3.1.0', info: { title,
version }, servers: [] })` and registers the shared `ProblemDetails` schema and one response
component per error code so each route lists exactly the codes it can produce. `/docs` is a
small HTML page assembled in the route file: a heading, an "Errors" section with one
`<section id="error-<code>">` per code giving status, title, and a sentence, and the Swagger
UI component from `@hono/swagger-ui` pointed at `/openapi.json`. Both carry `Cache-Control:
public, max-age=3600`.

A route's responses are keyed by status, and two codes can share one (`internal_error` and
`transform_timeout` at 500, `upstream_error` and `too_many_redirects` at 502). Where a route
can produce only one code at a status, its response is a `$ref` to that code's component;
where it can produce several, its response is one inline problem response whose description
names each code (decision 46). Every problem response's schema is
`allOf: [ProblemDetails, { properties: { code: { enum: [...] } } }]`, narrowed to the codes
it can carry, so a client can read them from the schema rather than the prose.

Every documented response lists the headers the service sets on it, each with a
description. All of them carry `Cache-Control` (its value as a `const`), `X-Request-Id`,
`Access-Control-Allow-Origin`, and `Access-Control-Expose-Headers`; `openapi.ts` supplies
these, and its problem responses, component or inline, add `Retry-After`, `RateLimit`, and
`RateLimit-Policy` where `rate_limited` is among their codes and `Allow` where
`method_not_allowed` is. The `/process` 200 adds the image headers of section 7 and
`Content-Length`, marked not required because a streamed delivery may arrive chunked; its
304 adds `ETag`. `Content-Type` is documented by each response's content map, since
OpenAPI 3.1 ignores a response header of that name. Headers added by the transport (the
Node server, the function URL, CloudFront) are not the service's and are not listed
(decision 62).

`/openapi.json` gets its `Cache-Control` from a middleware that sets it on a 200 only,
because `doc31` registers its own handler. The sentence per code on `/docs` lives in
`http/routes/docs.ts`. The Swagger UI component loads its script and stylesheet from the
jsDelivr CDN, the package's default, at a pinned `swagger-ui-dist` version (5.33.1), because
without one the package loads the latest release and the page would change underneath a
deployment.

## Tests

`apps/api/test/`:

- `process.test.ts`: the three example requests from the brief against the fake upstream;
  every response header in section 7 present with correct values; HEAD matches GET headers
  with an empty body; each validation failure returns 400 with the field named and a
  sentence; an unknown parameter is refused naming it, without a fetch; `width * height`
  over the pixel cap is a `width` field error; a 304 round trip using the returned `ETag`.
- `info.test.ts`: metadata for each format; the same errors as `/process` for bad URLs; any
  parameter other than `url` is refused naming it.
- `errors.test.ts`: table of every `ErrorCode` through `toProblem` asserting status, title,
  content type, `no-store`, `type`; an unknown `Error` becomes `internal_error` with no
  detail; a `ServiceError` with `cause` logs the chain; no `detail` contains a filesystem
  path, a stack frame, or an upstream response body (a hostname or a blocked address the
  caller caused is fine).
- `cache-control.test.ts`: every route, including `/openapi.json`, `/docs`, an unknown
  path, and a wrong method, carries the `Cache-Control` value section 7 assigns it.
- `routing.test.ts`: unknown path is 404 problem; `POST /process` is 405 with `Allow`;
  `/health` shape and `no-store`; `/openapi.json` lists the three paths and every
  parameter, and each documented response lists exactly the headers the service sends
  with it, with their values where it fixes them; `/docs` contains an anchor for every
  error code.
- `middleware.test.ts`: request-id accepted when valid, regenerated when not; the loop
  marker is refused; CORS headers present on 200, 304, and error responses.
