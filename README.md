# Image service

**Live:** [https://d244qv5g3kagmy.cloudfront.net](https://d244qv5g3kagmy.cloudfront.net)
(the UI at `/`, API docs at `/docs`), deployed from this repository to us-east-2 and kept
running for at least seven days from submission.

An HTTP service that fetches an image from a caller-supplied URL, resizes and re-encodes it,
and returns the result, with a single-page UI that calls the API through a dependency-free
TypeScript SDK. It deploys to AWS Lambda behind CloudFront with CDK and runs locally with no
AWS account. Because it fetches URLs supplied by anyone, it is built as an internet-facing
proxy: every outbound request goes through one fetch policy, every resource has a configured
bound, and every error is RFC 9457 problem details with a stable code. The design is in
[docs/architecture.md](docs/architecture.md), the reasons in
[docs/decisions.md](docs/decisions.md), and one document per subsystem in
[docs/design/](docs/design/). The npm workspaces are the service (`apps/api`), the UI
(`apps/web`), the SDK (`packages/sdk`), the test image server (`packages/fake-upstream`), the
CDK app (`infra`), and the Playwright suite (`e2e`); architecture section 3 states each
directory's responsibility.

## At a glance

`GET /process` fetches an image from a public URL, resizes it, converts its format, and
returns it; `GET /info` describes a source without transforming it. The brief's three
example requests, against the live service with public images:

```sh
L=https://d244qv5g3kagmy.cloudfront.net/process
J=https://upload.wikimedia.org/wikipedia/commons/3/3f/JPEG_example_flower.jpg
P=https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png
curl -sS -o out1.jpg  "$L?url=$J&width=500&height=300"                            # 314 by 300, aspect kept
curl -sS -o out2.jpg  "$L?url=$P&format=jpeg&quality=80"                          # transparency flattened on white
curl -sS -o out3.webp "$L?url=$J&width=800&height=600&format=webp&crop=fill"      # exactly 800 by 600
```

Built: the API with `crop=fit|fill|scale|pad` and `format=jpeg|png|webp|avif`, a UI, a
typed SDK and an OpenAPI document (the two bonuses taken), an SSRF-safe fetch policy, limits
on every resource, per-client rate limiting, edge and in-process caching, RFC 9457 errors,
and a CDK deployment reproducible from the repository. Bonuses not taken (decision 17):
video thumbnails (decision 16), `format=auto` (decision 24), CI, metrics, and extra
transformations such as rotate and blur. There is no
authentication: the service is an open proxy bounded by rate limits (decision 29). The full
list is under "Left out and next steps".

## Quick start

Requires Node 24 (see `.node-version`) and npm.

```sh
npm ci
npm run build             # SDK, API, and UI; the API and UI resolve the SDK through its dist/
npm run dev               # http://localhost:3000: the UI at /, API docs at /docs
npm test                  # unit and integration tests (Vitest); no test touches the network
npm test -- --coverage    # the same, with a coverage report
npm run test:e2e          # build, then Playwright (once: npx playwright install chromium)
npm run preflight         # format check, lint, typecheck and build, tests
```

The brief's three example requests against the local server, with the images from "At a
glance":

```sh
L=http://localhost:3000/process
J=https://upload.wikimedia.org/wikipedia/commons/3/3f/JPEG_example_flower.jpg
P=https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png
curl -sS -o out1.jpg  "$L?url=$J&width=500&height=300"
curl -sS -o out2.jpg  "$L?url=$P&format=jpeg&quality=80"
curl -sS -o out3.webp "$L?url=$J&width=800&height=600&format=webp&crop=fill"
```

A source must be public and reachable: the fetch policy refuses loopback, private, and
link-local addresses, so a URL on your own machine or network is answered 403
`url_not_allowed`.

Without network access, run the same requests against the fake upstream the tests use, with
its exact address allowed (the name `localhost` is always refused):

```sh
node packages/fake-upstream/src/cli.ts --port 4180 &
ALLOWED_HOSTS=127.0.0.1:4180 npm run dev

# in another shell
SRC='http://127.0.0.1:4180/image/jpeg?w=1000&h=800'
PNG='http://127.0.0.1:4180/image/png?w=1200&h=800&pattern=quadrants'
API=http://localhost:3000/process
curl -sS -G -o out1.jpg  "$API" --data-urlencode "url=$SRC" -d width=500 -d height=300
curl -sS -G -o out2.jpg  "$API" --data-urlencode "url=$PNG" -d format=jpeg -d quality=80
curl -sS -G -o out3.webp "$API" --data-urlencode "url=$PNG" -d width=800 -d height=600 \
  -d format=webp -d crop=fill
```

## How it works

`GET /process` runs: request ID, loop guard, rate limit, validation, URL rules, result cache,
fetch (or source cache), sniff, pixel bound, conditional check, transform, store, respond.
Architecture section 4 has the full lifecycle; section 6 lists the seams, which lint enforces.
API paths below are relative to `apps/api/src/`.

**HTTP surface** (`app.ts`, `http/`, `operations/`). A Hono app built from a `Config` and its
collaborators. Zod query schemas are typed against the SDK's parameter types with a
type-level equality test, so the two cannot drift, and they generate the OpenAPI document.
Every error passes through one mapping, `http/errors.ts`. The same app runs under a Node
server locally (`server.ts`) and Hono's Lambda streaming adapter in production (`lambda.ts`).
Use cases live in `operations/`. Logs carry source hostnames, never full URLs, since query
strings can carry tokens.

**Fetching** (`source/`: `policy.ts`, `fetcher.ts`, `sniff.ts`). A pure policy over a parsed URL
and resolved addresses; a fetcher that is the only module performing network I/O; a sniffer
that decides the type from magic bytes, since upstream `Content-Type` is never trusted.

**Transform** (`image/spec.ts`, `image/pipeline.ts`). The spec applies defaults and produces
the canonical cache key. The pipeline is the only importer of sharp: it reads dimensions from
the header before decoding, applies EXIF orientation, resizes, encodes, strips all metadata
(GPS tags included), and checks the output size.

**Caching and rate limiting** (`cache/`, `source/cache.ts`, `rate-limit/`). One byte-budgeted
LRU backs per-instance result and source caches; `RateLimiter` has memory and DynamoDB forms.

**SDK** (`packages/sdk`). Owns the public contract: parameter types, the error code union,
`ProblemDetails`. `processUrl` emits parameters in a fixed order, so equal requests produce
byte-identical URLs and share CloudFront entries. `ImageClient` returns typed results and
throws `ImageApiError` when a response arrived or `ImageApiTransportError` when none did, and
checks the type of every value it returns rather than casting untyped JSON.

**UI** (`apps/web`). One page in vanilla TypeScript: a pure `reduce` over a phase union, a
renderer that builds the page once and updates it, and API calls only through the SDK. It
shows the source and processed images with metadata, the request URL and a curl line, and any
problem with its code and request ID. API text reaches the DOM through `textContent` only.

Key trade-offs, each with a decision-log entry:

- **Lambda behind CloudFront.** Inside free tiers at this scale, apart from cents of DynamoDB,
  but memory is per instance, so CloudFront driven by `Cache-Control` and a strong `ETag` is
  the real result cache, and rate limiting needs DynamoDB (decisions 2, 11, 12).
- **Buffer, then deliver.** ETags, caching, and header-only dimension checks need the whole
  source; streaming is used only to pass Lambda's 6 MB buffered limit (decision 13).
- **`fit` by default.** Never crops or enlarges unless asked, so 500 by 300 may return 500 by
  281 (decision 8).
- **Status codes.** 403 for a policy refusal keeps 400 for "fix your parameters"; 413 and 415
  describe fetched content, as image proxies conventionally use them (decisions 9, 23).
- **No API key.** The UI would have to embed it and it would break edge cache sharing. The
  service is an open proxy bounded by rate limiting and reserved concurrency (decision 29).

## API

| Method and path | Purpose |
|---|---|
| `GET /process`, `HEAD /process` | Fetch, transform, return image bytes (HEAD: headers only) |
| `GET /info` | Source metadata: `url`, `finalUrl`, `format`, `width`, `height`, `bytes`, `pages` |
| `GET /health` | `{ "status": "ok", "version": "..." }` |
| `GET /openapi.json`, `GET /docs` | OpenAPI 3.1 document and interactive docs, with every error code |

| Parameter | Values | Default |
|---|---|---|
| `url` | `http` or `https` URL, subject to the fetch policy | required |
| `width`, `height` | integer 1 to 4096, product at most 16,000,000; omit one to keep aspect | none |
| `crop` | `fit` (inside the box, never enlarges), `fill` (exact, center crop), `scale` (exact, aspect ignored), `pad` (exact, padded) | `fit` |
| `format` | `jpeg`, `png`, `webp`, `avif` | source format; `png` for TIFF and GIF |
| `quality` | integer 1 to 100, lossy encoders only | 80 |

Any other parameter is a 400 `invalid_parameter` naming it, so `?widht=5` fails instead of
returning the image untransformed; `/info` takes only `url`. Integers are plain decimal
digits: `width=5`, not `05`, `5.0`, `5e0`, `+5`, or `0x5`. The dimension limits and default
quality are configuration defaults. They also hold for the size the transform will produce:
an output larger than the source on either axis must fit `MAX_OUTPUT_DIMENSION` and
`MAX_OUTPUT_PIXELS`, else 422. An output no larger than the source, including any request
without dimensions, is already bounded by `MAX_INPUT_PIXELS`; the AVIF cap applies to every
AVIF output. Inputs are JPEG, PNG, WebP, GIF, AVIF, and TIFF; animated inputs contribute
their first frame; SVG is refused (decision 14).

Image responses carry `Content-Type`, `ETag`, `Cache-Control: public, max-age=3600`,
`X-Image-Width`, `X-Image-Height`, `X-Image-Format`, `X-Result-Cache` (`hit` or `miss`,
in-process only), `X-Request-Id`, `X-Content-Type-Options: nosniff`, and
`Content-Disposition: inline`. A matching `If-None-Match` gets 304 without a transform. A
caller's `X-Request-Id` is kept if it matches `[A-Za-z0-9._-]{1,64}`. CORS allows any origin
and exposes `ETag`, `X-Request-Id`, the `X-Image-*` headers, `X-Result-Cache`, and the
rate-limit headers. Upstream headers are never forwarded.

Every error is `application/problem+json` with `Cache-Control: no-store` and a stable `code`
from the SDK's union. Validation failures add `errors: [{ field, message }]`, one per
rejected parameter; upstream failures add `upstreamStatus`. `type` is a relative reference
into `/docs`.

```json
{
  "type": "/docs#error-url_not_allowed",
  "title": "URL not allowed",
  "status": 403,
  "detail": "Address 169.254.169.254 is in blocked range 169.254.0.0/16.",
  "code": "url_not_allowed",
  "requestId": "19169437-4349-4436-a56c-fe83bd4bf8ab"
}
```

| Situation | Status | Code |
|---|---|---|
| Malformed, out-of-range, or unknown parameters, including output dimensions over limits | 400 | `invalid_parameter` |
| URL blocked by policy, including a blocked redirect hop or the loop marker | 403 | `url_not_allowed` |
| Source exceeds `MAX_SOURCE_BYTES` or `MAX_INPUT_PIXELS` | 413 | `source_too_large` |
| Source is not a supported image type, or cannot be decoded | 415 | `unsupported_source_type` |
| Output exceeds `MAX_OUTPUT_BYTES`; an output larger than the source on either axis would not fit `MAX_OUTPUT_DIMENSION` and `MAX_OUTPUT_PIXELS`; or an AVIF output would exceed `MAX_AVIF_OUTPUT_PIXELS` | 422 | `output_too_large` |
| Rate limited | 429 | `rate_limited` |
| Upstream returned non-2xx, was unreachable, or refused the connection | 502 | `upstream_error` |
| Too many redirects | 502 | `too_many_redirects` |
| Upstream exceeded the fetch budget | 504 | `upstream_timeout` |
| Transform exceeded its budget | 500 | `transform_timeout` |
| Unknown path | 404 | `not_found` |
| Known path, unsupported method (local server and Function URL only) | 405 | `method_not_allowed`, with `Allow` |
| Unexpected failure | 500 | `internal_error`, no internal detail |

In production two errors come from AWS rather than the service: Lambda's plain-text 429 when
reserved concurrency is exhausted, which the SDK reports as `internal_error` with the real
status, and CloudFront's own 403 for methods other than GET and HEAD.

## Limits and safeguards

Every limit is an environment variable parsed in `apps/api/src/config.ts`. The variables and
defaults are architecture section 8's, and the two change together.

| Variable | Default | Reason |
|---|---|---|
| `MAX_SOURCE_BYTES` | 15,000,000 bytes | Large photographs fit; bounds memory per request |
| `MAX_INPUT_PIXELS` | 50,000,000 (50 MP) | Decompression bomb guard, checked from the header before decoding |
| `FETCH_CONNECT_TIMEOUT_MS` | 3000 | Unreachable hosts fail fast |
| `FETCH_TOTAL_TIMEOUT_MS` | 8000 | Budget for the whole redirect chain and body |
| `MAX_REDIRECTS` | 3 | Enough for CDNs, not for loops |
| `TRANSFORM_TIMEOUT_SECONDS` | 5 | sharp's timeout takes whole seconds; bounds decode plus encode |
| `MAX_OUTPUT_DIMENSION` | 4096 | Larger outputs are a CPU attack, not a thumbnail. Checked on the request (400), and on the computed output when it is larger than the source on either axis (422) |
| `MAX_OUTPUT_PIXELS` | 16,000,000 (16 MP) | Caps the product of both dimensions: requested (400), and computed when the output is larger than the source on either axis (422) |
| `MAX_AVIF_OUTPUT_PIXELS` | 8,000,000 (8 MP) | sharp's timeout cannot stop the AVIF encoder; 8 MP at effort 0 encodes in about 2 s, inside the transform budget |
| `MAX_OUTPUT_BYTES` | 10,000,000 bytes | Keeps delivery inside the Lambda streaming budget; a 16 MP PNG can exceed 30 MB |
| `DEFAULT_QUALITY` | 80 | Conventional lossy default |
| `RESULT_CACHE_TTL_SECONDS` | 3600 | Also the `Cache-Control` max-age |
| `RESULT_CACHE_MAX_BYTES` | 100,000,000 bytes | Per-instance LRU budget |
| `SOURCE_CACHE_TTL_SECONDS` | 300 | Covers a user iterating on one image |
| `SOURCE_CACHE_MAX_BYTES` | 50,000,000 bytes | Per-instance budget for fetched sources |
| `RATE_LIMIT_PER_MINUTE` | 60 | Per client IP, counting requests that reach the origin; IPv6 keyed on the /64 |
| `RATE_LIMIT_BACKEND` | `memory` | `memory` or `dynamodb` |
| `RATE_LIMIT_TABLE` | none | Required when the backend is `dynamodb` |
| `CLIENT_IP_SOURCE` | `socket` | `socket`, `x-forwarded-for`, or `cloudfront` |
| `TRUSTED_PROXY_COUNT` | 0 | Used by `x-forwarded-for` mode |
| `PUBLIC_HOSTS` | empty | This service's own hostnames, refused as fetch targets. Empty in the default deployment (decision 26) |
| `ALLOWED_HOSTS` | empty | Exact `host[:port]` entries exempt from the IP-literal, address, and (with a port) port rules |
| `LOG_LEVEL` | `info` | |
| `PORT` | 3000 | Local server only |

The Lambda has 1536 MB, a 20 s timeout, and reserved concurrency 10. The timeout covers the
worst case of an 8 s fetch, a 5 s transform, and about 2 s to stream 10 MB, so an exceeded
budget is a shaped 504 or 500 rather than a platform kill. sharp's timeout does not interrupt
the AVIF or mozjpeg encoders, so AVIF encodes at effort 0 under `MAX_AVIF_OUTPUT_PIXELS` and
JPEG uses plain libjpeg; measured single-threaded on noise, 8 MP of AVIF takes about 2 s and
16 MP of JPEG about 0.3 s (decision 64).

**Fetch policy.** Every outbound request goes through `source/fetcher.ts`, with no exception
for trusted hosts. Before any network activity the URL must be `http` or `https` on port 80 or
443 with no userinfo, and the host must not be `localhost`, a `.local`, `.internal`, or
`.localhost` name, a `PUBLIC_HOSTS` entry, or an IP literal in a blocked range; Node's `URL`
canonicalizes forms like `0x7f.0.0.1` to `127.0.0.1` first. The fetcher then resolves each hop
once and checks every address, and one blocked address denies the fetch. The blocked ranges are
architecture section 5's table, which includes the cloud metadata address; IPv4-mapped,
IPv4-compatible, IPv4-translated, well-known NAT64, and 6to4 addresses are judged by the
IPv4 address they embed, and local-use NAT64 and Teredo are blocked whole. The
connection is made only to the checked addresses, through a custom `lookup` on the undici
agent, while the hostname stays the TLS server name and `Host` header, so there is no DNS
rebinding window. Redirects are followed manually, and every hop passes the rules again;
https-to-http is refused. The fetcher sends `Accept-Encoding: identity` and refuses encoded
responses, so the byte cap applies to the bytes that will be decoded; `Content-Length` is
checked before reading and the cap is enforced on the stream regardless. Two guards stop the
service fetching itself. The production guard is a marker: the fetcher sends
`X-Image-Service-Fetch: 1` on every request and the API refuses requests carrying it.
`PUBLIC_HOSTS` adds the service's own names when they are known before deploy (decision 26).
The Lambda also runs outside any VPC, a second layer rather than a replacement, since the
Lambda Runtime API listens on loopback. Rules and test table:
[docs/design/url-policy-and-fetching.md](docs/design/url-policy-and-fetching.md).

**Caching.** CloudFront keys on the full query string and nothing else, so SDK-built
canonical URLs share edge entries and hand-written ones with a different parameter order do
not. The `ETag` hashes the canonical request, the sharp version plus a pipeline revision, and
the source identity (upstream `ETag` or `Last-Modified`, else a hash of the bytes), so
CloudFront's revalidation gets a 304 unless something changed. Errors and `/health` carry
`no-store`, and any route that sets no `Cache-Control` gets `no-store`, so CloudFront never
serves one client's error to another. Per instance, the result cache and a five-minute source
cache skip work on warm instances. A source-cache hit skips the fetcher's address and redirect
checks (the URL rules still run first), which is safe because the entry was admitted by the
policy and cannot outlive its TTL.

**Rate limiting.** A fixed one-minute window per client: one atomic DynamoDB `ADD` per request
in production, a map locally. A fixed window admits up to twice the limit across a boundary,
accepted because the limit bounds abuse rather than meters use (decision 32). It applies to
`/process` and `/info`, counts invalid requests, and never sees CloudFront cache hits. Only
429s carry `Retry-After`, `RateLimit`, and `RateLimit-Policy`, so a cached 200 never carries
another client's values. In production the client IP is `CloudFront-Viewer-Address`,
trustworthy because the Function URL accepts only CloudFront's signed requests;
`x-forwarded-for` mode counts from the right, never the client-controlled leftmost entry. An
undeterminable client falls into one shared bucket, which fails closed. If DynamoDB errors or
exceeds 500 ms the request is allowed and the failure logged, since reserved concurrency
already caps the damage. Per-IP in-flight requests are not capped.

## Testing

- **Unit tests** beside the code (`*.test.ts`): the fetch policy, spec, and error mapping are
  table-driven; the pipeline, LRU, limiters, client-key derivation, logger, config, SDK, and
  UI state are tested through their public functions. Time comes from an injected clock.
- **Integration tests** (`apps/api/test/`) call the app in-process with real collaborators:
  the brief's examples, every response header, HEAD, 304 round trips, every error code,
  routing, CORS, and the fetcher's redirect, timeout, byte-cap, and header handling. A
  diagnostics-channel check shows a host resolving to a private address gets no TCP connection.
- **Infrastructure tests** (`infra/lib/image-service-stack.test.ts`) assert the template's
  load-bearing settings: forwarded headers, cache policy, IAM-only streaming Function URL,
  Lambda sizing, the table's TTL, and the invalidation.
- **End-to-end tests** (`e2e/`) start the fake upstream, the API, and an API limited to two
  requests a minute, and drive the built UI in Chromium by role and label: empty, loading,
  success, format conversion, copying and a failed copy, an original the browser cannot
  display, validation, blocked URL, non-image source, upstream errors, transport failure, and
  429.

`packages/fake-upstream` generates every test image with sharp at run time and serves
scenarios: redirect chains, slow headers and bodies, oversized and unannounced bodies, gzip,
lying content types, SVG, HTML, truncated files, any status, and validators.

Known gaps:

- The transform timeout is not provoked, since sharp's whole-second granularity makes a
  reliable trigger slow or flaky; its mapping is tested on sharp's error (decision 33).
- The fetcher's connect timeout, and the deadline tearing down a connection attempt in
  progress, have no hermetic test: a loopback connect cannot be made to hang.
- The https-to-http downgrade is tested in the policy table but not through the fetcher,
  which needs an HTTPS fake upstream (decision 40).
- The CDK bundling recipe is untested, since the template test skips bundling.

## Deployment

One CDK stack ([docs/design/infrastructure.md](docs/design/infrastructure.md)). CloudFront
routes `/`, `/index.html`, `/favicon.ico`, and `/assets/*` to an S3 bucket holding the UI and
everything else to a streaming Lambda Function URL that accepts only CloudFront's signed
requests. The origin request policy forwards exactly `CloudFront-Viewer-Address`,
`X-Image-Service-Fetch`, and `X-Request-Id`. The function is Node 24 on arm64 with sharp's
linux-arm64 binaries in the bundle, and a DynamoDB on-demand table holds rate-limit counters.
Each new function version invalidates `/docs*` and `/openapi.json`. The environment sets only
`RATE_LIMIT_BACKEND`, `RATE_LIMIT_TABLE`, and `CLIENT_IP_SOURCE`; nothing needs a secret.

```sh
npm ci
npm run build          # SDK, UI, API; the stack's UI asset is apps/web/dist
npx cdk bootstrap      # once per account and region
npm run deploy         # cdk deploy from infra/; approve the IAM changes; prints the outputs
```

Credentials, account, and region come from the ambient AWS environment; the stack sets no
`env`. The deploy needs network for the sharp install. Outputs: `DistributionDomain`, the URL
to use, and `FunctionUrl`, which refuses direct requests. `npm run synth` checks the template
after `npm run build` with no credentials and no network.

The first deploy confirms what synthesis cannot. Results from the live deployment:

1. `GET /health` returns the version, so CloudFront's signed requests are accepted and the
   bundle loads arm64 sharp. Confirmed (`{"status":"ok","version":"0.1.0"}`).
2. `GET /` returns the UI. Confirmed; the default root object applies before behavior
   matching.
3. `Content-Length` does not survive the streaming invoke: Lambda moves it to
   `x-amzn-Remapped-Content-Length` and delivers the body chunked, and a `HEAD` response
   carries `Content-Length: 0`. Clients measure size from the body, as designed.
4. Two clients: one sending more than 60 distinct `/process` requests in a minute gets 429
   while the other still gets 200. Confirmed with an IPv4 and an IPv6 client: exactly 60
   of 71 parallel requests succeeded, the rest got 429 with `Retry-After`, and the other
   client was unaffected, so `CloudFront-Viewer-Address` arrives.
5. After a code change and redeploy, `/docs` and `/openapi.json` show the new version. Not
   yet exercised; the first deployment is still the current one.

Encode times on Lambda (1536 MB, arm64), measured through the distribution on a cache miss:
an 8 MP AVIF at the cap in 1.6 s, a 16 MP JPEG in 1.5 s, and a 16 MP WebP in 3.1 s, all
inside the 5 s transform budget.

**Cold starts.** A new instance loads the bundle and sharp's native library before answering,
so its first request is slower, and its result and source caches start empty. No provisioned
concurrency is configured. A URL cached at the edge never reaches the function; an expired
edge entry revalidates with `If-None-Match`, which on a cold instance costs a fetch and, when
the upstream sends no validator, a transform. Rate-limit state is in DynamoDB and survives.

## Left out and next steps

Not built, with reasons in the decision log: video thumbnails (decision 16 describes the
constrained ffmpeg design if added), SVG input, `format=auto`, streaming transforms,
authentication and signed URLs, persistent result storage, CI, and metrics.

Next steps:

- Signed URLs, so the service stops being an open proxy, and AWS WAF rate rules.
- At the edge: a CloudFront Function canonicalizing query strings so hand-written URLs share
  cache entries and normalizing `Accept` for `format=auto`, and a custom error response that
  shapes Lambda's throttling 429 as problem details.
- A shared result cache (S3 or ElastiCache) so hits survive cold starts.
- GitHub Actions running preflight, the e2e suite, and `cdk synth` on every push, with
  deploy on merge through an OIDC role.
- CloudWatch metrics (latency, cache hit rate, error rate) via Embedded Metric Format with a
  small dimension set, and a retention period on the function's log group, currently unset.
- A custom domain and ACM certificate, which allow a TLS 1.2 minimum and setting
  `PUBLIC_HOSTS` before deploy (decision 26).

Open design questions found during implementation:

- **TLS minimum.** The default CloudFront certificate's TLS policy is fixed; see next steps.
- **Smaller items.** With `format` omitted, a PNG, TIFF, or GIF source still makes one
  in-process result-cache entry per `quality`, since the key is formed before the fetch; its
  ETag and conditional requests do not vary (decisions 58 and 60).

## How this was built

The architecture document, the per-subsystem design documents, and the decision log were
written and approved before any code. AI agents then implemented each commit under the rules
in [AGENTS.md](AGENTS.md), and before each was proposed to the author, a separate agent that
had not written it reviewed it adversarially.
