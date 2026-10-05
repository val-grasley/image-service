# Architecture

This document is the top-level design for the image processing service. It fixes what every
subsystem depends on: deployment shape, repository layout, request lifecycle, the fetch
policy, module seams, the public contract, and limits. Design documents under
`docs/design/` go deeper only where there are further decisions to make; their status is
listed in section 11. `docs/decisions.md` records why each choice was made and what was
rejected.

Implementers read this document first, then the design document for the subsystem being
changed. If an implementation needs to differ from a document, the document changes in the
same commit and the decision log gets an entry.

## 1. Purpose and scope

An HTTP service that fetches an image from a caller-supplied URL, resizes and re-encodes it,
and returns the result; a single-page UI that exercises the API as an ordinary consumer; and
a small TypeScript SDK that builds request URLs and types the error contract.

The service fetches URLs supplied by anyone, so it is designed as an internet-facing proxy
from the start: every fetch goes through one policy, every resource is bounded, and every
error is machine-readable.

In scope: `GET /process`, `HEAD /process`, `GET /info`, `GET /health`, OpenAPI
documentation, the UI, the SDK, AWS deployment via CDK, structured logs with request IDs.

Out of scope, with reasons in the decision log: video thumbnails, SVG input, streaming
transforms, `format=auto`, CI, metrics, signed URLs, authentication, persistent result
storage. The README lists what was left out and what would come next.

## 2. Deployment shape

```
                 ┌──────────────────────────────────────────────┐
  browser / SDK  │ CloudFront distribution                      │
  ──────────────►│   /, /assets/*  → S3 bucket (built UI)       │
                 │   default       → Lambda Function URL (OAC)  │
                 │   cache key: full query string, no headers   │
                 └───────────────┬──────────────────────────────┘
                                 │ streaming invoke
                 ┌───────────────▼──────────────────────────────┐
                 │ Lambda (nodejs24.x, arm64, 1536 MB, 20 s)    │
                 │   Hono app ── fetcher ──► public internet    │
                 │            ── DynamoDB rate-limit table      │
                 │   structured logs ──► CloudWatch Logs        │
                 └──────────────────────────────────────────────┘
```

**One application, two adapters.** The same Hono app object runs under a Node HTTP server
locally and under Hono's Lambda streaming adapter in production. Locally the Node server also
serves the built UI; in production S3 does.

**Response streaming.** The Function URL uses `RESPONSE_STREAM` invoke mode so outputs above
the 6 MB buffered limit can be delivered. Streaming is used only for delivery; processing is
buffered (decision 13). Lambda streams the first 6 MB without throttling and the remainder at
about 2 MB/s, which is why outputs are capped in bytes (section 8).

**CloudFront behaviors.** `/`, `/index.html`, `/favicon.ico`, and `/assets/*` route to S3;
the UI build places `index.html` and `favicon.ico` at the root of `dist/` and every other
asset under `dist/assets/`. Everything else routes to the Function URL with a cache policy
that includes all query strings and no headers or cookies, and an origin request policy that
forwards exactly three headers: `CloudFront-Viewer-Address`, `X-Image-Service-Fetch`, and
`X-Request-Id`. CloudFront forwards no other viewer header, so any header the service relies
on must appear in that list. The Function URL's auth type is `AWS_IAM` and the origin access
control signs requests, so the Lambda is reachable only through CloudFront; that is what
makes `CloudFront-Viewer-Address` trustworthy. CloudFront keys on the raw query string, so
only byte-identical query strings share an edge cache entry; the SDK builds canonical query
strings so its users get that sharing, and hand-written URLs with different parameter order
do not (decision 11). Responses with status 4xx or 5xx carry `Cache-Control: no-store` so
CloudFront never serves one client's error to another.

**No VPC.** Lambda runs outside any VPC, so it has no route to private address ranges. This is
a second layer behind the URL policy, not a replacement: the Lambda Runtime API listens on
loopback inside the sandbox, so loopback blocking matters here too.

**Cost ceiling.** Reserved concurrency on the function is the global budget. CloudFront,
Lambda, and CloudWatch Logs usage sit inside permanent free tiers at this scale. DynamoDB
on-demand costs cents.

**No secrets.** All configuration is environment variables set by the CDK stack. Nothing in
the deployment requires a credential the repository would have to hold.

Everything also runs locally with no AWS account: `npm run dev` starts the API serving the UI
with the in-memory rate limiter.

## 3. Repository layout

npm workspaces. Each directory has one responsibility, stated beside it. New files go in the
directory whose statement covers them. A file that fits no statement means the tree is
incomplete: extend this tree first, then create the file. Files named below are the ones that
are seams or entries; other files inside a directory are the implementer's choice within that
directory's statement.

```
.
├── AGENTS.md                 Agent guidelines. Canonical; CLAUDE.md imports it.
├── CLAUDE.md                 One line: an import of AGENTS.md.
├── .claude/skills/           One directory per skill, each holding SKILL.md. Loaded on demand.
├── README.md
├── package.json              Workspace root: scripts and dev dependencies. Beside it: lockfile, .npmrc, .node-version,
│                             tsconfig.base.json and the root tsconfig.json of references, eslint.config.js, vitest.config.ts, Prettier config,
│                             and dev.ts, the `npm run dev` launcher that runs the SDK, UI, and API watches and stops them together.
│                             Each workspace has tsconfig.json (typecheck of sources and tests) and, where it emits, tsconfig.build.json.
├── docs/
│   ├── architecture.md       This document.
│   ├── decisions.md          Decision log.
│   └── design/               One design document per subsystem (section 11).
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── server.ts         Local entry: Node HTTP server, serves apps/web/dist.
│   │   │   ├── lambda.ts         Lambda entry: streaming handler.
│   │   │   ├── app.ts            Builds the Hono app from a Config and its collaborators.
│   │   │   ├── config.ts         Parses environment into a typed Config. Sole reader of process.env.
│   │   │   ├── errors.ts         ServiceError: the one error type domain modules throw, carrying an SDK code.
│   │   │   ├── http/             HTTP surface only: routes, schemas, error mapping, middleware.
│   │   │   │   ├── routes/       One file per endpoint.
│   │   │   │   ├── middleware/   request-id, rate-limit, loop-guard.
│   │   │   │   ├── errors.ts     The mapping from ServiceError to problem-details responses.
│   │   │   │   └── openapi.ts    Assembles the OpenAPI document from route schemas.
│   │   │   ├── operations/       Use cases coordinating subsystems. No HTTP types, no sharp.
│   │   │   │   ├── process-image.ts    cache → fetch → sniff → bound → transform → store.
│   │   │   │   └── describe-source.ts  fetch → sniff → metadata, for /info.
│   │   │   ├── source/           Turning an untrusted URL into bytes.
│   │   │   │   ├── policy.ts     Pure. Section 5 as code.
│   │   │   │   ├── fetcher.ts    Sole performer of outbound network I/O.
│   │   │   │   ├── sniff.ts      Content type from magic bytes.
│   │   │   │   └── cache.ts      Short-TTL cache of fetched source bytes.
│   │   │   ├── image/
│   │   │   │   ├── spec.ts       TransformSpec: parsing, defaults, canonical form, cache key, output encoding.
│   │   │   │   └── pipeline.ts   Sole importer of sharp. TransformSpec + bytes → bytes + metadata.
│   │   │   ├── cache/            ByteLru (shared by both caches), ResultCache interface and memory implementation.
│   │   │   ├── rate-limit/       RateLimiter interface, memory and DynamoDB implementations, client key derivation.
│   │   │   └── observability/    logger.ts. The only writer to stdout.
│   │   └── test/                 Integration tests against the app, and their helpers.
│   └── web/
│       ├── index.html
│       ├── favicon.ico
│       ├── styles.css
│       ├── build.ts              esbuild script: bundle to dist/assets/, copy index.html and favicon.ico to dist/.
│       └── src/
│           ├── main.ts           Wiring: DOM events → state transitions → render.
│           ├── state.ts          State type and transitions. Pure.
│           ├── render.ts         State → DOM.
│           └── api.ts            Calls the API through the SDK; extracts metadata from responses.
├── packages/
│   ├── sdk/src/                  Published surface. Dependency-free; browser and Node.
│   │   ├── index.ts              Public exports.
│   │   ├── transform.ts          Parameter types, crop modes, formats, canonical URL builder.
│   │   ├── errors.ts             Error code union, ProblemDetails type, ImageApiError.
│   │   └── client.ts             fetch-based client returning typed results and errors.
│   └── fake-upstream/src/        Dev-only. Generates test images and serves them through scenario routes; used by api tests and e2e.
├── infra/                        CDK application: bin/app.ts, lib/, and cdk.json.
└── e2e/                          Playwright tests against the full local stack. playwright.config.ts starts the fake
                                  upstream and the API instances as webServer entries on the addresses in stack.ts;
                                  tests/ holds one spec per UI state group.
```

Unit tests live beside the code they test as `*.test.ts`. Coding rules beyond placement are
in AGENTS.md.

## 4. Request lifecycle: `GET /process`

1. **Request ID.** Accept `X-Request-Id` if it matches `[A-Za-z0-9._-]{1,64}`, else generate
   one. Attached to the log context and every response. In production the header arrives
   only because the origin request policy forwards it (section 2).
2. **Loop guard.** Reject with 403 `url_not_allowed` if the request carries the fetcher's
   marker header (section 5).
3. **Rate limit.** Resolve the client IP per `CLIENT_IP_SOURCE` (section 8), consult the
   `RateLimiter`. On rejection: 429 with `Retry-After`, `RateLimit`, and `RateLimit-Policy`
   headers per draft-ietf-httpapi-ratelimit-headers. These headers are sent only on 429, because
   a cached 200 would otherwise carry another client's stale values.
4. **Parse and validate.** Query parameters → `TransformSpec` via the route's Zod schema,
   typed against the SDK's parameter types so the two cannot drift. Validation failure → 400
   with field-level errors. The URL half of the policy (section 5, "URL rules") runs here so
   obviously bad URLs fail before any work.
5. **Canonicalize.** The spec's canonical form (defaults applied, parameters in a fixed
   order, values normalized) is the in-process cache key. The SDK emits the same fixed
   order without defaults, since `DEFAULT_QUALITY` is server configuration, so SDK-built
   URLs are byte-identical for equal parameters even though they are not the cache key.
6. **Result cache.** Look up by canonical key in the per-instance `ResultCache`.
7. **Fetch.** Through `source/fetcher.ts` under the rules in section 5. Source bytes are cached
   briefly by URL.
8. **Sniff and bound.** Determine the content type from magic bytes; reject types outside the
   input allowlist with 415. Read dimensions from the header; reject above `MAX_INPUT_PIXELS`
   with 413 before decoding.
9. **Conditional check.** Compute the ETag (section 7). If the request carries a matching
   `If-None-Match`, respond 304 with no body and skip the transform. When the upstream gave no
   validator this requires the source bytes, which step 7 has already fetched.
10. **Transform.** `image/pipeline.ts` applies EXIF orientation, resizes per crop mode, strips
    metadata, encodes. Bounded by `TRANSFORM_TIMEOUT_SECONDS` via sharp's timeout, which
    counts from when libvips opens the input. Output above `MAX_OUTPUT_BYTES` → 422.
11. **Store and respond.** Store in the result cache. Respond with bytes and the headers in
    section 7.

Any failure maps to exactly one problem-details response. Upstream response headers are never
forwarded.

`GET /info` runs steps 1 to 4 and 7 to 8 and returns the metadata as JSON.

On a result-cache hit at step 6, the response's stored ETag answers the conditional check
and steps 7 to 10 are skipped.

## 5. Fetch policy

These rules are normative. `source/policy.ts` implements them as pure functions over a parsed
URL and a list of resolved addresses; `source/fetcher.ts` applies them at every point where a
connection could be made. The design document adds the test table and mechanics; it does not
change these rules.

### URL rules (checked before any network activity)

- Scheme is `http` or `https`. Port is 80 or 443, explicit or implied.
- No userinfo (`user:pass@`).
- Hostnames are compared after lowercasing and removing one trailing dot.
- Host is not an IP literal in a blocked range (below), and is not a hostname in
  `PUBLIC_HOSTS` (the service's own CloudFront and Function URL hostnames), `localhost`, or
  the `.local`, `.internal`, or `.localhost` suffixes.
- An `ALLOWED_HOSTS` entry with an explicit port exempts exactly that `host:port` from the
  port rule, the IP-literal rule, and the address rules. An entry without a port exempts that
  host from the IP-literal and address rules on ports 80 and 443 only. The name rule
  (`localhost` and the blocked suffixes), scheme, userinfo, `PUBLIC_HOSTS`, redirect, and size
  rules apply regardless. This is what lets tests reach the fake upstream at
  `127.0.0.1:<port>` while nothing else on loopback is reachable.

### Address rules (checked on every resolved address, every hop)

| Family | Blocked |
|---|---|
| IPv4 | `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `224.0.0.0/4`, `240.0.0.0/4` |
| IPv6 | `::`, `::1`, `::/96` (deprecated IPv4-compatible, apply the IPv4 table), `::ffff:0:0/96` (IPv4-mapped, apply the IPv4 table), `::ffff:0:0:0/96` (IPv4-translated, SIIT, apply the IPv4 table), `64:ff9b::/96` (well-known NAT64, apply the IPv4 table), `64:ff9b:1::/48` (local-use NAT64, blocked whole), `2001::/32` (Teredo, blocked whole), `2001:2::/48` (benchmarking), `100::/64` (discard-only), `2002::/16` (6to4, apply the IPv4 table to the embedded address), `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8` |

A denial by these rules gives the problem a fixed category as its `detail` ("resolves to a
private or reserved address"), never the resolved address or the range it matched, either
of which inside a VPC would disclose internal DNS answers (decision 57). The fetcher's
denial log line carries the range, and its debug log the addresses.

### Connection rules

- DNS is resolved once per hop by the fetcher. Every returned address is checked, and one
  blocked address denies the whole fetch. The connection is made only to checked addresses,
  by supplying a custom `lookup` to the undici agent that returns the validated list. The
  hostname is still used for SNI, the `Host` header, and certificate validation. There is no
  second resolution, so there is no rebinding window.
- Connect timeout `FETCH_CONNECT_TIMEOUT_MS`. `FETCH_TOTAL_TIMEOUT_MS` is the budget for the
  entire redirect chain including body download.
- Redirects are not auto-followed. 301, 302, 303, 307, and 308 are followed manually, at most
  `MAX_REDIRECTS` times, resolving relative `Location` against the current URL. Each hop
  passes the URL rules and address rules. https to http downgrade is refused. A blocked hop →
  403 `url_not_allowed`; too many hops → 502 `too_many_redirects`.
- The fetcher uses undici's `request` through a dispatcher carrying the custom `lookup`, so
  it receives the raw body. Request headers sent upstream: `User-Agent` (service name and
  version), `Accept` listing the input types, `Accept-Encoding: identity`, and the loop-marker
  header `X-Image-Service-Fetch: 1`. A response with any `Content-Encoding` other than
  identity is refused with 502 `upstream_error`; the fetcher never decompresses, so the byte
  cap always applies to the bytes that will be decoded.
- `Content-Length`, when present, is checked against `MAX_SOURCE_BYTES` before reading. The
  cap is enforced on the stream regardless, and the request is aborted on breach → 413.
- Upstream status other than 2xx → 502 `upstream_error` with `upstreamStatus` in the problem.
- Upstream response headers are discarded after the fetcher has read `Content-Length`,
  `Content-Encoding`, `Location`, `Content-Type` (for logging only; it is never trusted),
  `ETag`, and `Last-Modified`.

### Loop guard

A request to this service whose URL points back at this service would recurse until reserved
concurrency was exhausted. Two guards: the marker header the fetcher always sends, which the
API refuses at step 2 of the lifecycle, and `PUBLIC_HOSTS` in the URL rules. The marker is
the production guard. It reaches the Lambda only because the origin request policy forwards
it (section 2); an infrastructure change that drops it from that list silently disables the
guard, which the infrastructure design document's checklist covers. `PUBLIC_HOSTS` is empty
in the default deployment: the function's environment cannot reference the distribution's
domain without a CloudFormation cycle (the distribution references the Function URL, which
references the function). It is set locally, in tests, and by anyone deploying with a custom
domain known before deploy (decision 26).

## 6. Subsystems and seams

| Subsystem | Location | Pure or effectful | Design document |
|---|---|---|---|
| Fetch policy | `source/policy.ts` | Pure | `design/url-policy-and-fetching.md` |
| Fetcher | `source/fetcher.ts` | Network | `design/url-policy-and-fetching.md` |
| Transform spec | `image/spec.ts` | Pure | `design/image-pipeline.md` |
| Pipeline | `image/pipeline.ts` | CPU | `design/image-pipeline.md` |
| HTTP contract | `http/` | I/O boundary | `design/http-api.md` |
| Caching | `cache/`, `source/cache.ts`, response headers | Memory | `design/caching.md` |
| Rate limiting | `rate-limit/` | Memory or DynamoDB | `design/rate-limiting.md` |
| Observability | `observability/` | stdout | `design/observability.md` |
| SDK | `packages/sdk` | Pure plus fetch | `design/sdk.md` |
| UI | `apps/web` | DOM | `design/ui.md` |
| Infrastructure | `infra/` | AWS | `design/infrastructure.md` |

Seams inside `apps/api/src` are enforced by lint. `no-restricted-imports` and
`no-restricted-globals` apply to that directory only; the SDK, UI, test server, and
infrastructure have their own needs for `fetch`, `console`, and `process.env`.

| Restricted in `apps/api/src` | Permitted only in |
|---|---|
| `fetch`, `undici` | `source/fetcher.ts` |
| `sharp` | `image/pipeline.ts` |
| `process.env` | `config.ts` |
| `console` | `observability/logger.ts` |

Test files (`*.test.ts` and `apps/api/test/`) are exempt from the `sharp` restriction only,
for reading metadata back from outputs. Fixtures come from the fake upstream's generator.

Two interfaces have more than one implementation by design: `RateLimiter` (memory, DynamoDB)
and `ResultCache` (memory now; a shared store is a documented next step). No other interface
is introduced for a single implementation.

Dependencies flow inward: `http/` → `operations/` → `source/`, `image/`, `cache/`,
`rate-limit/`. Nothing imports from `http/` except `app.ts` and the entries. `operations/`
receive their collaborators as arguments assembled in `app.ts`, which is what lets
integration tests substitute the fake upstream's address and a tiny rate limit without
touching production code paths.

Hono's `getConnInfo` is not used for anything security-relevant (its leftmost
`X-Forwarded-For` handling was CVE-2026-27700); the pinned version is at or above 4.12.2.

## 7. Public contract

Full detail, including every error code and the OpenAPI document, is in `design/http-api.md`.
This section is the contract the design document must not contradict.

### Endpoints

| Method and path | Purpose |
|---|---|
| `GET /process` | Fetch, transform, return image bytes |
| `HEAD /process` | Same headers, no body |
| `GET /info` | Source image metadata as JSON, without transforming |
| `GET /health` | Liveness; returns `{ status, version }` |
| `GET /openapi.json`, `GET /docs` | Specification and interactive documentation, including the error code list |

### `/process` parameters

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `url` | string | required | Section 5 |
| `width`, `height` | integer | none | 1 to `MAX_OUTPUT_DIMENSION`; product at most `MAX_OUTPUT_PIXELS`; one may be omitted to keep aspect |
| `crop` | `fit`, `fill`, `scale`, `pad` | `fit` | `fit` never enlarges; the others produce the exact requested size and may enlarge |
| `format` | `jpeg`, `png`, `webp`, `avif` | source format; `png` for TIFF and GIF sources | |
| `quality` | integer 1 to 100 | `DEFAULT_QUALITY` | Passed to lossy encoders only; not passed to the PNG or GIF encoders |

No other parameter is accepted: an unknown one, including a known name in another case, is
a 400 `invalid_parameter` naming it, so a misspelling cannot return an untransformed image
and extra parameters cannot mint cache keys (decision 61). `/info` accepts only `url`. A pair
with an empty name (`&=5`, `&&`, a trailing `&`) is dropped by the query parser before
validation, so it is not refused.

Integer parameters are accepted only as plain decimal digits with no sign, leading zero,
decimal point, exponent, or whitespace: `width=5`, not `05`, `5.0`, `0x5`, `5e0`, `+5`, or
` 5`. Each of those would otherwise be another cache key for the same result. A refused
spelling is the parameter's ordinary 400, whose message says what is accepted (decision 63).

Animated inputs contribute their first frame. AVIF encoding uses a fixed low effort so encode
time stays inside the transform budget.

### Response headers on image responses

`Content-Type`, `ETag`, `Cache-Control: public, max-age=<RESULT_CACHE_TTL_SECONDS>`,
`X-Image-Width`, `X-Image-Height`, `X-Image-Format`, `X-Result-Cache` (`hit` or `miss`, the
in-process cache only; CloudFront adds its own `X-Cache`), `X-Request-Id`,
`X-Content-Type-Options: nosniff`, `Content-Disposition: inline`.

On a CloudFront cache hit, `X-Request-Id` identifies the origin request that produced the
object; CloudFront's own `X-Amz-Cf-Id` identifies the viewer request.

Non-image responses set `Cache-Control` explicitly so CloudFront's default TTL never applies:
`/health` sends `no-store`; `/info` sends `public, max-age=<SOURCE_CACHE_TTL_SECONDS>`;
`/openapi.json` and `/docs` send `public, max-age=3600`, and the deploy step invalidates
both paths so a changed error code list is never stale at the edge; every 4xx and 5xx sends
`no-store`.

CORS: `Access-Control-Allow-Origin: *` on every response, since there are no credentials, and
`Access-Control-Expose-Headers` set to exactly `ETag`, `X-Request-Id`, `X-Image-Width`,
`X-Image-Height`, `X-Image-Format`, `X-Result-Cache`, `Retry-After`, `RateLimit`,
`RateLimit-Policy`. `ETag` is listed because it is not CORS-safelisted. Clients measure file size from the
received body, not from `Content-Length`, because streamed Lambda responses may be delivered
chunked.

### ETag and conditional requests

`ETag` is a strong hash over the canonical key (without quality once the output is known to
be png, decision 60), a pipeline version string (sharp's version plus a constant bumped on
behavior changes), and the source identity: the upstream `ETag` or `Last-Modified` when
present, else a hash of the source bytes. A conditional request is
answered 304 when the recomputed ETag matches. On a warm instance with the source or result
cached this costs nothing; on a cold instance it costs a fetch and, without an upstream
validator, a transform. A 304 therefore always saves bandwidth, always saves the transform
when the upstream supplies a validator, and saves everything when a cache is warm. CloudFront
revalidates with `If-None-Match` when its copy expires.

### Errors

Every error produced by the service is `application/problem+json` (RFC 9457) with a stable
`code` the SDK exports as a union type. The one error the service cannot shape is a 429 from
Lambda throttling when reserved concurrency is exhausted, which arrives as a plain-text body;
a CloudFront custom error response can convert it and is a listed next step.

```json
{
  "type": "/docs#error-url_not_allowed",
  "title": "URL not allowed",
  "status": 403,
  "detail": "Host photos.example resolves to a private or reserved address.",
  "code": "url_not_allowed",
  "requestId": "…"
}
```

`type` is a relative reference resolved against the request URL, so it is valid on any host.
Validation errors add `errors: [{ field, message }]`, one entry per rejected parameter; an
unknown parameter's message lists the ones the endpoint accepts
(`not accepted; use url, width, height, crop, format, quality`).

| Situation | Status | Code |
|---|---|---|
| Malformed, out-of-range, or unknown parameters, including output dimensions over limits | 400 | `invalid_parameter` |
| URL blocked by policy, including a blocked redirect hop or the loop marker | 403 | `url_not_allowed` |
| Source exceeds `MAX_SOURCE_BYTES` or `MAX_INPUT_PIXELS` | 413 | `source_too_large` |
| Source is not a supported image type | 415 | `unsupported_source_type` |
| Output exceeds `MAX_OUTPUT_BYTES` | 422 | `output_too_large` |
| Rate limited | 429 | `rate_limited` |
| Upstream returned non-2xx, was unreachable, or refused the connection | 502 | `upstream_error` |
| Too many redirects | 502 | `too_many_redirects` |
| Upstream exceeded the fetch budget | 504 | `upstream_timeout` |
| Transform exceeded its budget (sharp reports this as an error whose message contains `timeout`) | 500 | `transform_timeout` |
| Unknown path | 404 | `not_found` |
| Known path, unsupported method | 405 | `method_not_allowed`, with `Allow` |
| Unexpected failure | 500 | `internal_error`, no internal detail |

413 and 415 describe fetched content rather than the request body, which is a proxy
convention rather than their RFC 9110 meaning (decision 23).

Behind CloudFront, only `GET` and `HEAD` reach the service; CloudFront answers other
methods with its own 403, so `method_not_allowed` (405) is returned by the local server
and by the function URL, not by the deployed distribution (decision 56).

## 8. Limits and configuration

Every limit is an environment variable parsed in `config.ts`. The README reproduces this
table; when a default changes, both change. Supported input types are fixed, not configurable:
JPEG, PNG, WebP, GIF, AVIF, TIFF (decision 14).

| Variable | Default | Reason |
|---|---|---|
| `MAX_SOURCE_BYTES` | 15 MB (15,000,000) | Large photographs fit; bounds memory per request |
| `MAX_INPUT_PIXELS` | 50 MP | Decompression bomb guard; far below libvips's default |
| `FETCH_CONNECT_TIMEOUT_MS` | 3000 | Unreachable hosts fail fast |
| `FETCH_TOTAL_TIMEOUT_MS` | 8000 | Whole redirect chain and body |
| `MAX_REDIRECTS` | 3 | Enough for CDNs, not for loops |
| `TRANSFORM_TIMEOUT_SECONDS` | 5 | sharp's timeout takes whole seconds; bounds decode plus encode |
| `MAX_OUTPUT_DIMENSION` | 4096 | Larger outputs are a CPU attack, not a thumbnail |
| `MAX_OUTPUT_PIXELS` | 16 MP | Caps the product of both dimensions |
| `MAX_OUTPUT_BYTES` | 10 MB (10,000,000) | Keeps delivery inside the Lambda streaming budget; a 16 MP PNG can exceed 30 MB |
| `DEFAULT_QUALITY` | 80 | Conventional lossy default |
| `RESULT_CACHE_TTL_SECONDS` | 3600 | Also the `Cache-Control` max-age |
| `RESULT_CACHE_MAX_BYTES` | 100 MB (100,000,000) | Per-instance LRU budget |
| `SOURCE_CACHE_TTL_SECONDS` | 300 | Covers a user iterating on one image |
| `SOURCE_CACHE_MAX_BYTES` | 50 MB (50,000,000) | |
| `RATE_LIMIT_PER_MINUTE` | 60 | Per client IP, counting requests that reach the origin; edge cache hits are not counted. IPv6 clients keyed on their /64 |
| `RATE_LIMIT_BACKEND` | `memory` | `memory` or `dynamodb` |
| `RATE_LIMIT_TABLE` | none | Required when backend is `dynamodb` |
| `CLIENT_IP_SOURCE` | `socket` | See below |
| `TRUSTED_PROXY_COUNT` | 0 | Used by `x-forwarded-for` mode |
| `PUBLIC_HOSTS` | empty | This service's own hostnames, refused as fetch targets. Empty in the default deployment; see section 5 |
| `ALLOWED_HOSTS` | empty | Exact `host[:port]` entries exempt from the IP-literal, address, and (with a port) port rules |
| `LOG_LEVEL` | `info` | |
| `PORT` | 3000 | Local server only |

**Client IP.** `socket` uses the TCP peer, correct only with no proxy. `x-forwarded-for` takes
the entry `TRUSTED_PROXY_COUNT` from the right, never the leftmost, which the client controls.
`cloudfront` reads `CloudFront-Viewer-Address`, which CloudFront sets and the origin request
policy forwards, and strips the port by splitting on the last colon, which handles both
`203.0.113.9:443` and `[2001:db8::1]:443`. Its trustworthiness rests on the Function URL being
reachable only through CloudFront (section 2). Production uses `cloudfront`.

**Request budget.** Lambda timeout 20 s. Worst case inside it: fetch 8 s, transform 5 s,
delivery of 10 MB at 6 MB unthrottled plus 2 MB/s for the rest, about 2 s. A request that
exceeds its fetch or transform budget gets a shaped 504 or 500 rather than a platform kill.
Per-IP in-flight requests are not capped: one client can hold all reserved concurrency for the
duration of its requests, bounded by the rate limit. This is accepted at this scale.

Lambda settings in CDK: 1536 MB memory, 20 s timeout, reserved concurrency 10.

## 9. Tooling and testing

| Concern | Choice |
|---|---|
| Runtime | Node 24, ESM. API dev loop via native type stripping with `erasableSyntaxOnly`; relative imports carry `.ts` extensions, which `rewriteRelativeImportExtensions` rewrites on emit; fallback `tsx` |
| Packages | npm workspaces, exact versions, lockfile committed |
| Types | TypeScript 5.9 (decision 34), `tsc -b` with project references; strict plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `rewriteRelativeImportExtensions` |
| Lint | ESLint, typescript-eslint strict type-checked, seam rules from section 6 |
| Format | Prettier |
| Unit and integration tests | Vitest; integration tests call the app in-process against `fake-upstream` |
| End-to-end | Playwright, Chromium, against the built UI and a local API |
| Coverage | Reported, not gated |
| Preflight | `npm run preflight` = format check, lint, typecheck, unit and integration tests. The gate before every commit |

**Consuming the SDK inside the repository.** The SDK's `package.json` points at its built
`dist/`. Vitest aliases the SDK to its source, so unit and integration tests need no build.
Everything that resolves the package through Node or esbuild does: `npm run dev` runs the
SDK's `tsc --watch` beside the API, and the UI build, the Lambda bundle, `cdk synth`, and the
e2e suite run after `npm run build`, which builds the SDK first.

No test touches the network. The fake upstream is the only way an image enters a test, and
tests set `ALLOWED_HOSTS` to exactly its address.

## 10. Deliberately not designed

These have one obvious implementation and no document: the health endpoint, config parsing,
logger setup, the request-id middleware, the loop-guard middleware, the esbuild script.

## 11. Document status

| Document | Status |
|---|---|
| `architecture.md`, `decisions.md` | Approved |
| `design/url-policy-and-fetching.md` | Drafted, under review |
| `design/fake-upstream.md` | Drafted, under review |
| `design/http-api.md` | Drafted, under review |
| `design/caching.md` | Drafted, under review |
| `design/rate-limiting.md` | Drafted, under review |
| `design/image-pipeline.md` | Drafted, under review |
| `design/infrastructure.md` | Drafted, under review |
| `design/observability.md`, `design/sdk.md`, `design/ui.md` | Drafted, under review |

This document governs implementation once every design document above exists; each is
approved in the commit that adds it.

## 12. Next steps beyond this scope

Recorded here so the README can cite them: a shared result cache (S3 or ElastiCache) so cache
hits survive cold starts; a CloudFront Function that canonicalizes query strings at the edge
so hand-written URLs share cache entries; `format=auto` with `Accept` normalized at the edge;
a CloudFront custom error response that shapes Lambda throttling as problem details; signed
URLs so the service is not an open proxy; streaming transforms for inputs above the byte cap;
video thumbnails via ffmpeg in a container-image Lambda; AWS WAF rate rules; a GitHub Actions
workflow running preflight, the e2e suite, and `cdk synth` on every push, with deploy-on-merge
via an OIDC role; CloudWatch metrics for latency, cache hit rate, and error rate via Embedded
Metric Format, with a deliberately small dimension set since each combination is billable.
