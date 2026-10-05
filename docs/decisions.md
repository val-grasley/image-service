# Decision log

One entry per decision that shaped the system: the context, the choice, what was rejected and
why, and the consequences. Once a document is approved, entries are appended rather than
rewritten; a reversed decision gets a new entry referencing the old one.

All entries below date from the design phase, 2026-10-02, unless marked otherwise.

---

## 1. TypeScript on Node 24

**Context:** The brief prefers TypeScript. The API, UI, SDK, and infrastructure all need a
language.
**Decision:** TypeScript throughout. Node 24 as the runtime.
**Rejected:** Go or Rust for the API: libvips does the heavy work in any language, so the
speed difference is marginal, and a single language lets the SDK, API, and infrastructure
share types.
**Consequences:** One toolchain. The SDK's types are the source of truth for the API's
validation schemas.

## 2. Deploy to AWS Lambda behind CloudFront

**Context:** Deployment is optional in the brief. AWS is the target environment. Compute must
stay inside free tiers.
**Decision:** Lambda (arm64, response streaming via a Function URL with `AWS_IAM` auth and
origin access control, so it is reachable only through CloudFront) behind a CloudFront
distribution, with the UI served from S3 as a second origin. Similar in shape to AWS's Dynamic
Image Transformation solution, which uses API Gateway or S3 Object Lambda in front of sharp;
this design uses a streaming Function URL instead to escape the 6 MB buffered limit.
**Rejected:** Render: simpler, but its free tier sleeps and it shows nothing about the target
environment. Fly.io: no longer has a free tier. Fargate or App Runner: not free, and an
always-on container fits this bursty workload worse. Lambda@Edge: no environment variables, no
response streaming, a 1 MB cap on generated response bodies for origin events, and
us-east-1-only deployment.
**Consequences:** In-memory state is per instance, so CloudFront becomes the real result cache
(11) and rate limiting needs a shared store (12). Streaming delivery throttles after 6 MB, so
output bytes are capped (27). Cold starts exist and are documented.

## 3. CDK over SAM and Terraform

**Context:** Infrastructure must be reproducible from the repository. Both CDK and Terraform
are in use at the target environment.
**Decision:** AWS CDK in TypeScript.
**Rejected:** SAM: good for Lambda alone, but CloudFront, S3 hosting, and origin access control
fall back to raw CloudFormation, and sharp bundling is manual. Terraform: equally credible,
but needs a state backend before the first deploy and offers nothing for Lambda bundling,
which is the riskiest part of this deployment.
**Consequences:** Infrastructure is a workspace in the same language as the application.
`cdk synth` runs without credentials, so the stack can be checked before any deploy.
CloudFormation deploys are slow but roll back.

## 4. Hono over Fastify

**Context:** Need an HTTP framework that runs identically under a local Node server, under
Lambda, and in-process in tests, and that derives OpenAPI from the validation schemas.
**Decision:** Hono with Zod via `@hono/zod-openapi`.
**Rejected:** Fastify: mature and well known, and its Lambda adapter does support streaming,
but it is built on Node's request and response objects, so each environment needs an adapter
and in-process tests go through `inject`. Hono is built on the web-standard `Request` and
`Response`, so the same app object runs in all three places with no translation, and
`@hono/zod-openapi` makes route schemas the OpenAPI document. Express: no first-class typing
or OpenAPI.
**Consequences:** One app object, two adapters. The pinned version is at or above 4.12.2
(CVE-2026-27700 in `getConnInfo`), and `getConnInfo` is not used for the rate-limit key.

## 5. sharp for image processing

**Context:** Need resize, crop modes, format conversion, orientation handling, metadata
stripping, decode-bomb protection, and a processing timeout.
**Decision:** sharp (libvips).
**Rejected:** Jimp (pure JS, far slower, fewer formats). ImageMagick via child process (larger
attack surface, slower, harder to bound).
**Consequences:** Platform-specific binaries must be bundled for linux-arm64.
`limitInputPixels`, header-only metadata reads, and `timeout` give the input and time bounds.

## 6. No UI framework

**Context:** The UI is one interactive page whose job is to make the API legible. Visual design
is not graded.
**Decision:** Vanilla TypeScript with a single state object and a single render function,
bundled by esbuild, which is a devDependency anyway because CDK's `NodejsFunction` uses it
when present.
**Rejected:** React with Vite: most of the code would be about the framework rather than the
API, and Vite's dev server and asset pipeline are unused for one page. Astro: designed for
mostly-static pages with islands; this page is one island.
**Consequences:** Somewhat more UI code than React. The SDK is demonstrated with zero framework
assumptions. Text from the API is inserted with `textContent`, never `innerHTML`.

## 7. npm workspaces, six packages

**Context:** API, UI, SDK, infrastructure, test server, and e2e tests have different
dependency sets and build steps.
**Decision:** npm workspaces: `apps/api`, `apps/web`, `packages/sdk`, `packages/fake-upstream`,
`infra`, `e2e`.
**Rejected:** pnpm: stricter isolation, but another install step for reviewers. A single
package: the CDK bundle, the browser bundle, and the published SDK would share one dependency
graph and one tsconfig, which does not work.
**Consequences:** Project references for type checking. The fake upstream is a package because
both the API's integration tests and the e2e suite need it.

## 8. Default crop mode is `fit`

**Context:** When both dimensions are given, something has to give: aspect ratio, pixels, or
exact size.
**Decision:** Default to `fit`: output is at most the requested size, aspect preserved, no
cropping, no enlargement. `fill`, `scale`, and `pad` are opt-in and produce the exact size.
**Rejected:** `scale` (Cloudinary's default): distorts silently. `fill`: produces the exact
size but discards pixels without being asked; the brief's own example passes `crop=fill`
explicitly, implying it is not the default.
**Consequences:** A request for 500 by 300 may return 500 by 281. The UI and docs state this.

## 9. 403 for policy-blocked URLs

**Context:** A well-formed URL that the policy refuses to fetch is neither a malformed request
nor an upstream failure.
**Decision:** 403 with code `url_not_allowed`, including for a blocked redirect hop and for
the loop marker.
**Rejected:** 400: conflates "fix your syntax" with "this is forbidden", and SDK users would
have to parse codes to distinguish them.
**Consequences:** 400 is reserved for validation. The SDK can branch on status alone.

## 10. RFC 9457 problem details for every error

**Context:** Errors must be predictable and tell the caller what to fix.
**Decision:** `application/problem+json` with a stable `code` union exported by the SDK, a
`requestId`, and field-level `errors` for validation failures. `type` is a relative reference
into the served docs so it is valid on any host.
**Rejected:** An ad hoc `{ error: string }` shape: not machine-readable, no standard.
**Consequences:** One error mapping function. Adding an error code touches the SDK union, the
mapping, and the OpenAPI document. Lambda's own throttling 429 is the one error the service
cannot shape; it is documented as a hole with a CloudFront custom error response as the fix.

## 11. CloudFront is the result cache

**Context:** Lambda instances do not share memory and do not persist.
**Decision:** Correct `Cache-Control`, a strong `ETag`, and 304 handling make CloudFront the
cache for processed results. In-memory LRUs for results and source bytes remain as
warm-instance optimizations. Error responses carry `no-store`.
**Rejected:** S3 or ElastiCache as a shared cache: correct and the documented next step, but
a second stateful resource for a benefit CloudFront already provides at the edge. A
CloudFront Function canonicalizing query strings at the edge: the one place edge code would
earn its keep, but it must mirror the API's canonicalization exactly and is deferred for that
reason.
**Consequences:** CloudFront keys on the raw query string, so only byte-identical URLs share
an edge entry; the SDK emits canonical URLs and gets that sharing, hand-written URLs may not.
The ETag includes a pipeline version so a sharp upgrade invalidates cached results on
revalidation.

## 12. Rate limiting as an interface with memory and DynamoDB implementations

**Context:** Per-instance counters are meaningless on Lambda, where a burst creates instances.
**Decision:** A `RateLimiter` interface. Memory implementation for local runs and tests.
DynamoDB implementation for production, on-demand billing, negligible cost at this volume.
Reserved concurrency on the function as the global request budget.
**Rejected:** AWS WAF rate rules: the proper production tool, but not free. API Gateway
throttling: per client only through API keys and usage plans, not per IP, and API Gateway
does not support response streaming.
**Consequences:** One DynamoDB table in the stack. The limiter runs in the Lambda, so it
protects origin compute, which is what costs money; CloudFront cache hits are not counted.
The rate-limit headers are sent only on 429 responses so a CloudFront-cached 200 never
carries another client's values. Per-IP in-flight requests are not capped; accepted at this
scale.

## 13. Buffer, do not stream, within a request

**Context:** Caching, ETags, and header-only dimension checks all want the whole source in
memory. Limits bound that memory to tens of megabytes.
**Decision:** Fetch the source fully (bounded), transform fully, then deliver. Lambda response
streaming is used only to exceed the 6 MB buffered payload cap, not to pipeline work.
**Rejected:** Streaming transforms: lower memory, but incompatible with the ETag and cache
design and unnecessary under the chosen limits.
**Consequences:** Memory per request is bounded by `MAX_SOURCE_BYTES` plus `MAX_OUTPUT_BYTES`.
Documented as a next step for larger inputs.

## 14. SVG input is not supported

**Context:** sharp rasterizes SVG through librsvg, which parses XML and may reference external
resources.
**Decision:** SVG is excluded from the input allowlist. Input types: JPEG, PNG, WebP, GIF, AVIF,
TIFF.
**Rejected:** Allowing SVG with sanitization: the sanitization surface is large and the benefit
small for a resize service.
**Consequences:** 415 for SVG sources, with a message saying so.

## 15. Strip metadata on output

**Context:** Source images often carry EXIF including GPS coordinates.
**Decision:** Apply EXIF orientation, then strip all metadata from every output.
**Rejected:** Preserving metadata by default, or an option to keep it. No caller of a resize
service needs the original GPS tags, and an option is a footgun.
**Consequences:** Outputs are smaller and carry no location data.

## 16. Video thumbnails are out of scope

**Context:** A bonus item. Tools can be installed freely.
**Decision:** Not built.
**Rejected:** A constrained version: fetch through the safe fetcher, pipe to ffmpeg with a hard
kill timer, container-image Lambda. Feasible, but the image size caps do not fit video,
trailing MP4 metadata needs range requests, and ffmpeg is a far larger attack surface than
libvips.
**Consequences:** README lists the constrained design as the path if it were added.

## 17. Bonus set

**Context:** The brief asks for at most one or two bonus items.
**Decision:** The SDK and OpenAPI with interactive docs. Neither is separable from the core
design: the SDK's types are the source of truth for the API's validation schemas and error
contract, and the OpenAPI document is a by-product of the route schemas (decision 4).
**Rejected:** GitHub Actions CI: it would re-run gates every commit already passes locally
before it lands. CloudWatch metrics via Embedded Metric Format: small to emit, but it adds a
dimension-set decision and cost caveats for a demo nobody will watch dashboards for.
Structured logs and request IDs are kept because the error contract and Lambda logging need
them regardless. Video (16). `format=auto` (24).
**Consequences:** Two bonuses. CI and metrics are listed as next steps with enough detail to
build from.

## 18. ESLint with type-aware rules, and Prettier

**Context:** The project's quality rules target structural problems: redundant checks, type
escape hatches, bypassed seams.
**Decision:** ESLint with typescript-eslint's strict type-checked preset, plus
`no-restricted-imports` and `no-restricted-globals` encoding the architectural seams within
`apps/api/src`. Prettier for formatting.
**Rejected:** Biome: one fast tool, but no type-aware rules, and type-aware rules are what
catch `no-unnecessary-condition` and friends mechanically.
**Consequences:** Lint runs slower. Bypassing the fetcher, config, logger, or pipeline inside
the API is a lint failure.

## 19. Native Node type stripping in development, provisionally

**Context:** Node 24 runs TypeScript directly if the syntax is erasable. Node refuses to strip
types under `node_modules`, but workspace symlinks resolve to real paths, so workspace
packages are not affected.
**Decision:** `node --watch` on source for the API dev loop, with `erasableSyntaxOnly` in
tsconfig. The SDK is consumed through its built `dist/` (its `tsc --watch` runs beside the API
in dev); Vitest aliases the SDK to source. Fall back to `tsx` if this causes friction.
**Rejected:** `tsx` as the default: fine, but one more dependency when the runtime does the job.
**Consequences:** No enums, no parameter properties. Verified or reversed at scaffold time.
Addendum 2026-10-03: verified. Node 24.18 runs the API sources directly and `tsc -b` emits
them from the same files.

## 20. Test strategy: no network, fake upstream, Playwright for the whole stack

**Context:** Tests must be deterministic, and the SSRF behavior must be testable.
**Decision:** Vitest unit tests beside the code; integration tests call the app in-process
against a fake upstream serving every scenario (formats, redirects, private redirect targets,
slow and oversized bodies, lying content types); Playwright e2e against the built UI and a
local API. Coverage reported, not gated.
**Rejected:** Coverage thresholds: breed tautological tests. Mocking sharp: tests would test
the mock. Real internet URLs in tests: flaky and non-hermetic.
**Consequences:** `ALLOWED_HOSTS` exists so tests can reach loopback while every other private
address stays blocked (21).

## 21. Exact-match host allowlist

**Context:** Tests and self-hosters both need to permit a specific private host without
disabling private-address blocking.
**Decision:** `ALLOWED_HOSTS`, a list of exact `host[:port]` entries. An entry with a port
exempts exactly that `host:port` from the port, IP-literal, and address rules; an entry
without a port exempts the host from the IP-literal and address rules on 80 and 443 only. The
name rule, scheme, userinfo, `PUBLIC_HOSTS`, redirect, and size rules apply regardless.
**Rejected:** A boolean `ALLOW_PRIVATE`: turns off the most important protection wholesale and
would make the redirect-to-private tests impossible.
**Consequences:** Tests allow exactly the fake upstream's loopback address and ephemeral
port, and nothing else on loopback is reachable.

## 22. Lambda sizing and the request budget

**Context:** Lambda CPU scales with memory; sharp is CPU-bound; streamed delivery is throttled
after 6 MB.
**Decision:** 1536 MB, 20 s timeout, reserved concurrency 10. The timeout covers the sum of
the fetch budget (8 s for the whole redirect chain), the transform budget (5 s via sharp's
whole-second timeout), and delivery of a maximum-size output (about 2 s), with margin.
**Rejected:** Smaller memory: slower per request and no cheaper per unit of work. Unbounded
concurrency: no cost ceiling on a public endpoint. A 15 s timeout: did not account for
delivery time.
**Consequences:** Callers see a shaped 504 or 500 rather than a platform kill when a budget is
exceeded.

## 23. Status codes for fetched-content problems

**Context:** RFC 9110 defines 413 and 415 for the request's own content. Here the oversized or
unsupported content is the fetched source, and the fix is still in the caller's hands.
**Decision:** 413 `source_too_large` for a source over the byte or pixel cap; 415
`unsupported_source_type` for an unsupported type; 422 `output_too_large` for a transform
whose output exceeds the byte cap; 502 `upstream_error` for any non-2xx upstream status, with
the upstream status in the problem; 502 `too_many_redirects`; 504 `upstream_timeout`; 500
`transform_timeout`.
**Rejected:** 422 with codes for all fetched-content problems: RFC-cleaner, but 413 and 415
are what callers of image proxies expect and read correctly at a glance. Mirroring the
upstream's own status (404 for an upstream 404): ambiguous with this service's own routing.
**Consequences:** The status table in the architecture document is complete, and each row
has one code.

## 24. `format=auto` is out of scope

**Context:** Content negotiation from `Accept` is a listed bonus. CloudFront strips `Accept`
before forwarding unless it is in the cache key, and drops `Vary: Accept` from responses.
**Decision:** Not built. The correct deployment needs a CloudFront Function normalizing
`Accept` to a small set and a cache policy keyed on it.
**Rejected:** Shipping it for the local server only: a feature that silently does nothing in
production is worse than none.
**Consequences:** Listed as a next step with the edge design.

## 25. No request coalescing

**Context:** Lambda runs one request per execution environment, so two concurrent misses never
share an instance, and CloudFront already collapses concurrent requests for one cache key.
**Decision:** No in-process single-flight. The local server does not need it either.
**Rejected:** Keeping it for the local server: dead code in the deployment the design is for.
**Consequences:** `cache/` holds the interface and the LRU only.

## 26. Two guards against self-fetch

**Context:** A request whose `url` points at this service would recurse until reserved
concurrency was exhausted, and the service's own hostnames resolve to public addresses, so the
address rules alone would allow it.
**Decision:** The fetcher sends a marker header on every upstream request and the API refuses
any request carrying it. This is the production guard. `PUBLIC_HOSTS` lists the service's own
hostnames and the URL rules refuse them; it is set locally and in tests, and is empty in the
default deployment because a Lambda environment variable cannot reference the distribution's
domain without a CloudFormation cycle. A deployment with a custom domain known in advance
sets it.
**Rejected:** A two-step deploy that writes the distribution domain into the function after
the first deploy: works, but makes "reproducible from the repository" a two-command story for
one defensive variable. Dropping the marker and relying on hostnames: an alias or the bare
Function URL defeats it. A header-only design with no `PUBLIC_HOSTS` at all: loses a cheap
second layer wherever the hostname is known.
**Consequences:** The marker header is named in the origin request policy, which the
infrastructure document calls out as load-bearing. One more config variable; one more
middleware.

## 27. Output byte cap

**Context:** 16 MP of PNG can exceed 30 MB. Lambda streams the first 6 MB freely and about
2 MB/s after, so a 30 MB response takes longer than the function timeout.
**Decision:** `MAX_OUTPUT_BYTES` of 10 MB, checked after encoding; breach returns 422
`output_too_large` with advice to reduce dimensions or use a lossy format. AVIF uses a fixed
low encoder effort so encode time stays inside the transform budget.
**Rejected:** Lowering `MAX_OUTPUT_PIXELS` to about 4 MP: keeps every PNG small but punishes
JPEG and WebP, whose 16 MP outputs are a few megabytes. Streaming the output as encoded: the
encoder has to finish before the size is known.
**Consequences:** Work is occasionally wasted on an output that is then refused, bounded by the
transform budget.

## 28. Client IP source

**Context:** Behind CloudFront the Function URL sees CloudFront's address, CloudFront appends
the viewer IP to the end of `X-Forwarded-For`, and viewers can seed that header.
**Decision:** `CLIENT_IP_SOURCE` selects `socket`, `x-forwarded-for` (the entry
`TRUSTED_PROXY_COUNT` from the right, never the leftmost), or `cloudfront`
(`CloudFront-Viewer-Address`, forwarded by the origin request policy, port stripped).
Production uses `cloudfront`. IPv6 clients are keyed on their /64.
**Rejected:** Leftmost `X-Forwarded-For`: client-controlled, and the cause of Hono's
CVE-2026-27700. Hono's `getConnInfo`: see decision 4.
**Consequences:** Misconfiguration behind a proxy puts every client in one bucket, which fails
closed rather than open.

## 29. No API key

**Context:** An optional `X-Api-Key` was considered as a cheap way to close the open proxy.
**Decision:** Not built.
**Rejected:** The option: the browser UI would have to embed the key, so it would be public;
CloudFront would serve cached results to keyless callers unless the header joined the cache
key, destroying sharing; and the brief wants the UI to call the API as any public consumer
would. Signed URLs are the right mechanism and are a listed next step.
**Consequences:** The service is an open proxy bounded by rate limiting and reserved
concurrency, and the README says so.

## 30. Problem details for routing errors too

**Date:** 2026-10-03
**Context:** A request for an unknown path or an unsupported method on a known path is an
error the service produces, and section 7 promises every such error is problem details.
**Decision:** 404 `not_found` for unknown paths; 405 `method_not_allowed` with an `Allow`
header for a known path and unsupported method. Both are problem details with `no-store`.
**Rejected:** Hono's default plain-text 404 for both cases: inconsistent with the contract,
and a wrong-method request would be indistinguishable from a wrong path.
**Consequences:** The HTTP design document fixes how 405 is produced, since Hono does not
distinguish the two cases by default.

## 31. Runtime dependencies

**Date:** 2026-10-03
**Context:** AGENTS.md requires a log entry for every runtime dependency. The API's set is
fixed here so later additions stand out.
**Decision:** `hono`, `@hono/zod-openapi`, `@hono/node-server`, `@hono/aws-lambda`,
`@hono/swagger-ui`, `zod`, `sharp`, `undici`, and `@aws-sdk/client-dynamodb`. The SDK has
none. The UI depends only on the SDK.
**Rejected:** Node's global `fetch` instead of the `undici` package: it follows redirects
and decompresses automatically, which would bypass the per-hop policy and the byte cap; the
package's `request` returns raw responses and exposes the connector `lookup` for address
pinning. `pino` for logging: the logger is under eighty lines and every field is chosen, so
a dependency buys nothing. `file-type` for sniffing: six signatures in a table. Scalar instead
of `@hono/swagger-ui` for the docs page: either works; the Hono-org package keeps the
dependency set in one family.
**Consequences:** Nine runtime dependencies in the API, all pinned exactly. Workspace
packages (`@image-service/sdk`) are not counted.

## 32. Fixed-window rate limiting that fails open

**Date:** 2026-10-03
**Context:** The limiter must be a single DynamoDB round trip to stay cheap, and DynamoDB can
be unavailable.
**Decision:** A fixed one-minute window with an atomic `ADD` counter per key and window. On
a DynamoDB error or timeout the request is allowed and the failure is logged.
**Rejected:** Sliding window or token bucket: more precise at the boundary, but needs a
read before write or a conditional update, doubling cost for a limit whose job is bounding
abuse, not metering. Failing closed: turns a DynamoDB incident into a full outage when
reserved concurrency already caps the damage.
**Consequences:** Up to twice the limit can pass across a window boundary. A DynamoDB outage
degrades to the global concurrency cap only.

## 33. The transform timeout is not provoked in tests

**Date:** 2026-10-03
**Context:** sharp's timeout has whole-second granularity and is checked from libvips
progress callbacks, so a test that provokes it needs work that reliably exceeds a second on
any machine, which is either slow or flaky.
**Decision:** The error mapping is tested by constructing the error sharp produces; the real
timeout path is not exercised in the suite.
**Rejected:** A large AVIF encode as the trigger: deterministic enough but adds tens of
seconds to every run. Marking the test retryable: the preflight skill forbids `retry`.
**Consequences:** One documented gap, listed in the README's testing section together with
the fetcher's connect timeout, which has no hermetic test because a loopback connect cannot
be made to hang.

## 34. TypeScript 5.9 for tooling

**Date:** 2026-10-03
**Context:** TypeScript 7 is the native compiler. It exposes no JavaScript compiler API, and
typescript-eslint's supported range stops before it, so type-aware linting cannot run on it.
**Decision:** Pin `typescript` to 5.9.x. Every tsconfig flag the architecture relies on
exists there.
**Rejected:** TypeScript 7 for speed: it would mean dropping type-aware lint rules, which
decision 18 made load-bearing. TypeScript 6.0: inside the lint range but adds deprecation
errors for no benefit here.
**Consequences:** Relative imports use `.ts` specifiers with `rewriteRelativeImportExtensions`
so the same source runs under Node's native type stripping and compiles with `tsc`.

## 35. One typecheck project per workspace, plus a build project where it emits

**Date:** 2026-10-03
**Context:** The scaffold used `tsconfig.json` for emit (sources only) and `tsconfig.test.json`
for tests, with ESLint given an explicit glob list of projects. Adding the remaining
workspaces showed two problems: typescript-eslint parses every project its globs match, so
an empty workspace is a hard error for every file; and the project service, which avoids
that, resolves the nearest `tsconfig.json` and so needs that file to include tests.
**Decision:** Each workspace's `tsconfig.json` typechecks sources and tests with `noEmit`;
workspaces that emit (sdk, fake-upstream, api) add `tsconfig.build.json`. ESLint uses the
project service. The root `tsconfig.json` references every project that builds today.
**Rejected:** The explicit project list: breaks on empty workspaces and must be edited for
every new one. A separate Node-typed project for `apps/web/build.ts`: the UI's one tsconfig
gives browser sources Node types too, which would let `Buffer` or `process` typecheck and
fail in the browser. Separating them needs a solution-style web tsconfig plus two leaf
configs for one build script; that cost was judged not worth it for a single page reviewed
by hand.
**Consequences:** Sources are typechecked twice where a build project exists, which is cheap
at this size. Commits that create a workspace's first source add its references.

## 36. The fixture generator refuses specs it cannot honor

**Date:** 2026-10-04
**Context:** The generator encodes every fixture with sharp, and sharp cannot carry every
spec into every format. Probed against sharp 0.35.5: `withMetadata({ orientation })` drops
the tag for GIF, and for AVIF rotates the pixels and stores no tag. An alpha channel is
dropped for JPEG and TIFF (the output has three channels), and GIF keeps the channel but
rounds half opacity to fully opaque.
**Decision:** `generateImage` rejects with a `RangeError` for `orientation` with GIF or AVIF
and for `alpha` with JPEG, TIFF, or GIF. The server answers such a request 400.
**Rejected:** Encoding anyway and silently producing a fixture that lacks what its spec
claims. A test asking for an oriented GIF or a transparent JPEG would pass or fail for
reasons unrelated to the code it tests.
**Consequences:** Oriented fixtures are JPEG, PNG, WebP, or TIFF; transparent fixtures are
PNG, WebP, or AVIF. A test of flattening onto an opaque output starts from one of the
transparent formats.

## 37. The rate-limit client key is a pure module the middleware calls

**Date:** 2026-10-04
**Context:** The rate-limiting design placed client-key derivation inside the HTTP
middleware. The derivation carries the security-relevant rules (rightmost `X-Forwarded-For`
entry with a trusted count, the CloudFront port split, IPv6 /64 masking, `unknown` on no
address), and the limiter landed before the middleware.
**Decision:** `rate-limit/client-key.ts` exports `clientKey`, a pure function of the socket
address, a header lookup, and `CLIENT_IP_SOURCE` and `TRUSTED_PROXY_COUNT`. The middleware
is its caller. Two details the design left open are fixed there: an IPv4-mapped IPv6 address
is keyed as its IPv4 address, and text that is not an IP address yields `unknown`.
**Rejected:** Deriving the key inline in the middleware: every rule would be testable only by
building a request through the app, and the table of cases would be buried among the 429
header tests.
**Consequences:** The derivation's tests are a table over `clientKey`; the middleware's tests
cover only wiring and the response. Without the IPv4-mapped rule, a server listening on a
dual-stack socket would put every IPv4 client in the one bucket `0:0:0:0::/64`.

## 38. Address checks read every NAT64 layout and deny what they cannot read

**Date:** 2026-10-04
**Context:** Review of the fetch policy found three fail-open or crash paths in the address
rules. `64:ff9b:1::/48` was read only at its last 32 bits, but it is a local-use NAT64
prefix (RFC 8215) whose operator may use any RFC 6052 layout of /48 or longer, and the /48
layout carries the IPv4 address in bits 48 to 87. A resolution that was not an IP address
matched no range and passed. An embedding-prefix address carrying a zone index made the
embedded-address parse throw.
**Decision:** Read `64:ff9b:1::/48` addresses at the /96, /64, /56, and /48 layouts and deny
if any reading is in a blocked range. Deny a resolution that is not an IP address. Drop the
zone index before reading an embedded address.
**Rejected:** The last 32 bits only: misses the /48 layout and the others. Letting a non-IP
string through: it fails open, since nothing checked it.
**Consequences:** An address that is public in one layout but zero-filled in another reads
as `0.0.0.0/8` there and is denied, which blocks most of `64:ff9b:1::/48` in practice. The
policy table has a row per layout.

## 39. The fetcher takes its logger per call and its service version through `FetcherDeps`

**Date:** 2026-10-04
**Context:** The design document's `FetcherDeps` held the resolver, the policy, and the
limits, but its "Logging" section requires the fetcher to log denials and fetches, and
section 5 of the architecture requires a `User-Agent` carrying the service version, which
no module under `source/` can know. Its prose also said `resolve` has a default while the
type made it required. The logger is per request: `design/caching.md` passes it to
`processImage` as a separate argument so dependencies are built once.
**Decision:** `fetchSource(url, deps, log)` and `BoundFetch = (url, log) => …`, the logger
following the same convention as `processImage`. `serviceVersion: string` is added to
`FetcherDeps`, and `resolve` becomes optional with the `dns.promises.lookup` default the
prose describes. These add detail to an existing seam rather than create a new one.
`BoundFetch` is declared beside its first importer, since `fetcher.ts` does not use it.
**Rejected:** `log` as a `FetcherDeps` field: `BoundFetch` is bound once in `app.ts`, so the
fetcher's lines would carry the application logger and lose the request's `requestId`.
Importing the API's `package.json` into the fetcher for the version: the build project's
`rootDir` is `src`, so the import fails to compile, and the version would then be read in a
second place when `/health` needs it. A hardcoded version string: drifts from the manifest.
**Consequences:** `app.ts` passes the version when it binds `fetchSource`, and operations
pass their request logger on every call.

## 40. Fetcher-level downgrade test deferred to the author

**Date:** 2026-10-04
**Context:** The https-to-http downgrade rule is tested in the policy table. Testing it
through the fetcher needs an https first hop, which the fake upstream cannot serve because
Node 24 generates no certificates.
**Decision:** The design's fetcher test bullet stays as a requirement, marked deferred; no
relaxation is taken. The author chooses between recording policy-table-only coverage (a
relaxation, with its own entry) and adding a checked-in test certificate plus a CA option to
`FetcherDeps`.
**Rejected:** Silently dropping the bullet. A spy on `checkUrl`: that is mocking.
**Consequences:** One required test is absent until the author rules. The README (sequence
item 18) lists it among the testing gaps. A checked-in certificate would mean committing a
private key, which AGENTS.md forbids; if TLS coverage is chosen, the certificate is generated
at test time.

## 41. The transform-timeout match covers the first line of sharp's message

**Date:** 2026-10-04
**Context:** The pipeline design matched sharp's timeout with `/^timeout: \d+% complete$/`,
taking the message to be that one line. Provoked against sharp 0.35.5 (a 1-second timeout on
a large blur), the message is `timeout: <n>% complete` followed by libvips's own lines, for
example `\nVipsImage: killed for image "temp-97"` and sometimes a line from the encoder. The
anchored pattern would map every real timeout to `internal_error`. Decision 33 tests the
mapping by constructing the error, which needs the mapping callable on its own.
**Decision:** Match `/^timeout: \d+% complete(?:\n|$)/`: the first line exactly, whatever
follows. The mapping is `fromSharpError` in `image/pipeline.ts`, exported for its table test,
which includes the observed multi-line form.
**Rejected:** Matching `timeout` anywhere in the message: a decoder or encoder message that
mentions a timeout would be reported as the transform budget. The `m` flag: it would match
the text on any line, not only the first.
**Consequences:** A real timeout reaches the caller as `transform_timeout`. The same probes
found that sharp's timeout does not interrupt AVIF encoding or mozjpeg's JPEG encoding: a
16 MP noise image took about 19 s as AVIF at effort 2 under a 5 s timeout, and 6183 ms as
mozjpeg JPEG under a 1 s timeout (plain libjpeg finishes in about 350 ms), while WebP was
interrupted at 1011 ms. That is recorded here as an observation for the author, not
addressed by this entry; the encoder options are unchanged.

## 42. `inspect` reports dimensions after EXIF orientation

**Date:** 2026-10-04
**Context:** The pipeline design had `inspect` read width and height from the header without
saying whether EXIF orientation applies. sharp's `metadata()` gives both the stored
dimensions and, under `autoOrient`, the oriented ones, from the header alone.
**Decision:** `inspect` returns the oriented dimensions.
**Rejected:** The stored dimensions: `/info` would report 400 by 200 for an image that
browsers and `/process` show as 200 by 400.
**Consequences:** The pixel bound is unaffected, since the product is the same.

## 43. `method_not_allowed` carries its `Allow` list on `ServiceError`

**Date:** 2026-10-04
**Context:** The HTTP design has `app.all(path, ...)` throw `method_not_allowed` with the
path's `Allow` list and `toProblem(err, requestId)` add `Allow` on 405, but `ServiceError`
had no field to carry the list from one to the other.
**Decision:** `ServiceError` gains an optional `allow`, set only by the 405 handler. The
list is derived from the routes registered on the app, plus HEAD wherever GET is
registered.
**Rejected:** A constant `GET, HEAD` in `toProblem`: true of every route today, silently
wrong once a route adds a method. Setting the header on the context before throwing: it
reaches the problem response only through Hono's header merge on `c.res`, which is
incidental behavior.
**Consequences:** One more optional field on the domain error, alongside `rateLimit`,
which is likewise there for a response header.

## 44. The service version is an input to the app, supplied by each entry

**Date:** 2026-10-04
**Context:** `/health`, the OpenAPI `info.version`, and the fetcher's `User-Agent` need the
API package's version. A JSON import of `../package.json` does not compile, because the
build project's `rootDir` is `src`. Reading the manifest with `createRequire` from `app.ts`
works from `src/` and `dist/` but not from the Lambda bundle, where no manifest sits at
that relative path and esbuild does not follow `createRequire`.
**Decision:** `createApp(config, deps, serviceVersion)` and
`defaultDeps(config, serviceVersion)` take the version as an argument, and `app.ts` does no
file I/O. `server.ts` reads `../package.json` through `createRequire(import.meta.url)` and
validates `version` with Zod, which is stable because it runs only from `src/` or `dist/`.
`lambda.ts` (sequence item 17) will use a build-time constant, declared
`declare const SERVICE_VERSION: string` and supplied by the CDK bundling's esbuild `define`
from the manifest. Tests pass a literal.
**Rejected:** A JSON import with the `type: 'json'` attribute: fails `rootDir`. The manifest
read in `app.ts`: breaks in the bundle. A version string in source or in config: drifts from
the manifest.
**Consequences:** Each entry owns how it learns the version. The infrastructure commit adds
the `define`.

## 45. `toSpec` accepts the query schema's output

**Date:** 2026-10-04
**Context:** The route's query schema uses `.optional()`, as the HTTP design fixes, so its
output types an omitted field as `number | undefined`. Under `exactOptionalPropertyTypes`
that is not assignable to `ProcessParams`, whose optional fields exclude `undefined`, so
the validated query could not be passed to `toSpec(params: ProcessParams)`.
**Decision:** `toSpec` takes `ProcessParams` with `| undefined` added to each optional
field, a mapped type in `image/spec.ts`. It already treats `undefined` as absent.
**Rejected:** Zod's `.exactOptional()`: its output matches `ProcessParams` exactly, but
probed against zod-to-openapi 9.1.0, an `.exactOptional()` query field that carries
`.openapi()` metadata, as every parameter here does for its description, is documented as
`required: true`.
Copying each defined field into a fresh object in the handler: six conditionals that exist
only for the type checker. A `.transform()` producing `ProcessParams`: its annotation would
satisfy the type lock by itself and defeat it.
**Consequences:** The type lock in `process-query.test.ts` still compares the schema's own
output, through `Normalize`, against `ProcessParams`.

## 46. Codes that share a status on one route share one OpenAPI response

**Date:** 2026-10-04
**Context:** The HTTP design registers one response component per error code so that each
route lists exactly the codes it can produce. OpenAPI keys a route's responses by status,
one response per status, and on `/process` two pairs of codes share a status (500 and 502),
as on `/info` one pair does (502). Two components cannot both be referenced at one status.
**Decision:** Every code still has its component. A route refers to a code's component when
that code is the only one it can produce at that status; otherwise the route has one inline
`application/problem+json` response at that status whose description names each code, for
example `Upstream error (upstream_error) or Too many redirects (too_many_redirects).` Every
problem response, component or inline, has the schema
`allOf: [ProblemDetails, { properties: { code: { enum: [...] } } }]` with the enum narrowed
to the codes it can carry, so the code set is machine-readable.
**Rejected:** Per-code schema components combined with `oneOf` at the shared status: the
codes differ only in the `code` value, which the narrowed enum already states. The
description alone: only prose would say which codes a status admits. Listing only one of
the codes: the document would omit a code the route produces.
**Consequences:** `not_found` and `method_not_allowed` have components that no operation
references, since no GET operation produces them; `/docs` lists every code regardless.

## 47. The client checks the types of what it returns and reports a malformed 2xx as `internal_error`

**Date:** 2026-10-04
**Context:** `design/sdk.md` took `ProcessResult` from the image headers without saying what
happens when one is missing, and returned the `/info` body as `SourceInfo` "without
re-validation". Read literally, a 2xx without `X-Image-Width` yields `width: 0` or `NaN`, and a
2xx HTML page (a wrong base URL, an intermediary) escapes as a bare `SyntaxError`. Separately,
`Response.json()` and `JSON.parse` are typed `any`, AGENTS.md forbids casts, and
typescript-eslint's `no-unsafe-assignment` and `no-unsafe-return` reject handing `any` to a
typed value (verified by linting a probe in `packages/sdk`). There is no cast-free way to type
either JSON body without a runtime check.
**Decision:** The client checks every value it returns or throws against its declared type.
On `/process`, `Content-Type`, `ETag`, and `X-Request-Id` must be non-empty, the dimensions
positive integers, `X-Image-Format` an output format, and `X-Result-Cache` `hit` or `miss`.
The `/info` body must have every `SourceInfo` field with its type and a known source type. A
problem-details body must have every `ProblemDetails` field with its type and a code from
`ERROR_CODES`, a runtime list in `errors.ts` from which `ErrorCode` is now derived, as
`CropMode` is from `CROP_MODES`. A 2xx that fails is `ImageApiError` with code
`internal_error`, the response's own status, a detail naming the header or body, the request
ID header or empty, and the JSON parse failure as `cause` where there was one. A
problem-details body that fails is treated as a non-problem body.
**Rejected:** A cast at the two JSON sites, which AGENTS.md forbids. A type guard that checks
only that the body is an object, which is a cast in another form. `ImageApiTransportError`
for a malformed 2xx: a response did arrive, and its request ID is worth reporting. Status 502
for the synthesized problem: it would invent a status the response did not have, where the
non-2xx synthesis already reports the actual one.
**Consequences:** Types are checked, values are not: the API stays the trusted party for
ranges, as the design intended. `ImageApiError.status` can be a 2xx status for these errors.
An API that adds an error code, source type, or output format must ship with an SDK that
knows it; an older SDK reports the new code as `internal_error` with the body text and
rejects a `/info` body with the new source type. In this repository the UI bundles the SDK
from the same commit, so they ship together.

## 48. The form asks `main.ts` to submit, and the page is mounted once

**Date:** 2026-10-04
**Context:** `design/ui.md` gave `render(state, root, dispatch)` listeners that call
`dispatch`, and had `main.ts` create the `AbortController` and the request URL that the
`submit` event carries, so the form's listener had no event it could dispatch without
creating them itself. The same document had `render` rebuild the dynamic regions on every
call; since every keystroke is a `field` event, a rebuilt form loses the input being typed
in, and a rebuilt copy button loses the focus a keyboard user just gave it. `run(form,
signal)` had no client to call and no request URL to put in its event.
**Decision:** `render.ts` exports `mount(root, dispatch)`, which builds the page once and
returns an update function closed over its elements and the last phase it rendered; each
update changes only text, attributes, and the children of the regions derived from the
phase, and those only when the phase object changed. `main.ts` holds the update function,
never element references. `dispatch` takes an `Event` or `{ type: 'submit-requested' }`,
and `main.ts` turns the latter into `submit`. `run` takes the client and the request URL
from `main.ts`. `reduce` settles a `loading` phase only with an event whose `requestUrl` is
the same object, so a replaced request's abort failure is dropped in the pure function
rather than by a check in `main.ts`; `requestUrl` is therefore always a `URL` on `error`
and `failed`. `effectsFor` lives in `state.ts`, since importing `main.ts` starts the page.
**Rejected:** Creating the URL and controller in `render.ts`: it would need the base URL and
`paramsFromForm`, which the design gives to `main.ts`. A second channel beside `dispatch`
for submit. Keeping `render(state, root, dispatch)` with element references in a
module-level map keyed by the root: the same behavior with hidden module state and a
first-call branch. Rebuilding everything and restoring focus by element ID: it loses the
caret position and composition state and still reloads the images. Dropping stale results
in `main.ts` by checking `signal.aborted`: correct, but untested without a DOM.
**Consequences:** The update function holds mutable state, the last rendered phase.
Phase-derived regions depend on `reduce` returning the same phase object for events that do
not change it, which the state tests assert.

## 49. Each copy button is described by its status; the request text stays unnamed

**Date:** 2026-10-04
**Context:** `design/ui.md` puts one `aria-live` status beside each copy button but gave
nothing that ties a status to its button, so assistive technology that revisits a button
cannot tell which copy succeeded, and the end-to-end suite, which locates by role and
label only, could not assert which indicator showed. A review also noted that the request
URL and curl `code` elements have no accessible names.
**Decision:** Each copy button names its status element in `aria-describedby`, the pattern
the inputs already use for their field errors. The `code` elements stay unnamed: ARIA 1.2
prohibits `aria-label` and `aria-labelledby` on the `code` role, and Playwright computes no
name for it (a probe page showed `getByRole('code', { name })` matching neither attribute).
The suite locates them as the `code` elements of the Request region, in order, and the
buttons beside them carry the names.
**Rejected:** `aria-labelledby` on the `code` elements: an ARIA authoring error that a
checker flags and screen readers may ignore. `role="status"` on the indicators: it would
make them locatable but still not tie each to its button. Visible captions above each
`code`: a layout change the design did not ask for.
**Consequences:** While the indicator shows, a copy button's accessible description is
"Copied"; otherwise it is empty.

## 50. The UI does not cache-bust a resubmission

**Date:** 2026-10-04
**Context:** The end-to-end suite found that submitting the same parameters twice never
reaches the API the second time: `/process` answers `Cache-Control: public,
max-age=<RESULT_CACHE_TTL_SECONDS>` and `/info` a public max-age too, so the browser answers
from its HTTP cache. `design/ui.md` did not say whether that is intended.
**Decision:** It is. An identical resubmission may be served from the browser's cache under
the section 7 contract, and the UI adds no cache-busting parameter or `cache: 'no-store'`.
**Rejected:** A cache-busting query parameter: it would make the displayed URL differ from
`processUrl`'s output and defeat the CDN cache the canonical URL exists for. `no-store` on
the SDK's fetch: it would turn every resubmission into an origin request and a
rate-limit hit for no new information.
**Consequences:** A resubmission shows the cached result without a new origin request.
Tests that need a second origin request change a parameter.

## 51. The Lambda bundle defines `require` for bundled CommonJS

**Date:** 2026-10-04
**Context:** The bundling recipe in `design/infrastructure.md` produced an ESM bundle that
fails at load with `Dynamic require of "node:https" is not supported`. undici and other
dependencies are CommonJS; esbuild bundles their `require` calls of Node built-ins through a
shim that throws in ESM output unless a `require` binding exists in module scope. Verified by
running the recipe's esbuild arguments on `lambda.ts` and importing the result with a stub
`awslambda` global: it threw before the banner and answered `GET /health` with the manifest
version after.
**Decision:** The bundling sets `banner` to
`import { createRequire as bundleCreateRequire } from 'node:module'; const require = bundleCreateRequire(import.meta.url);`.
The import is aliased because a bundled module that imports `createRequire` itself would
otherwise collide with the banner's binding at the bundle's top level.
**Rejected:** CommonJS output: `@hono/aws-lambda` and the app are ESM and the design fixes
`format: ESM`. Marking undici and the AWS SDK external and installing them like sharp: more
of the asset outside the lockfile's control, to avoid one line.
**Consequences:** The bundle's built-in `require` calls resolve normally. A real bundle
(synthesized with bundling, the sharp install included) holds `index.mjs` and sharp 0.35.5
with its linux-arm64 binaries, 23 MB unzipped.

## 52. CloudFront is granted `lambda:InvokeFunction` on the function, through the URL only

**Date:** 2026-10-04
**Context:** Lambda documents that function URLs created since October 2025 require both
`lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` from the caller ("Control access to
Lambda function URLs"), and CloudFront's guide for origin access control on function URLs
grants both to `cloudfront.amazonaws.com`. `FunctionUrlOrigin.withOriginAccessControl` in
aws-cdk-lib 2.272.0 adds only the first, so CloudFront's signed requests would be refused
with 403.
**Decision:** `api.grantInvokeUrl` to the CloudFront service principal with an
`aws:SourceArn` condition on the distribution. The L2 helper adds `lambda:InvokeFunction`
with `InvokedViaFunctionUrl: true`, so the grant cannot be used to invoke the function any
other way.
**Rejected:** `addPermission` with the action written out: hand-written IAM where an L2
helper exists. Leaving it to a CDK upgrade: the first deploy would fail.
**Consequences:** The function's policy holds a second, equivalent `lambda:InvokeFunctionUrl`
statement beside the origin's. CDK warns that an `InvokeFunction` permission sits on the
unqualified function while `currentVersion` is used; the URL targets the unqualified
function, so the warning does not apply. Whether the URL accepts CloudFront's requests is
confirmed on the first deploy.

## 53. `npm run synth` skips bundling through the app's context, not the CLI's

**Date:** 2026-10-04
**Context:** `design/infrastructure.md` gave `cdk synth --context aws:cdk:bundling-stacks='[]'`.
CDK CLI 2.1144.0 refuses it: "User-provided context cannot use keys prefixed with 'aws:'",
and it sets `aws:cdk:bundling-stacks` to every stack for `synth` itself, with no flag to
change that short of `--exclusively` on another stack.
**Decision:** `npm run synth` runs `node bin/app.ts` with `CDK_CONTEXT_JSON` carrying the
empty bundling list and `CDK_OUTDIR=cdk.out`, which is how the CLI passes context to an app,
then `cdk synth --app cdk.out --quiet`, which reads that assembly and reports its warnings
and errors. The template test builds its `App` with the same context.
**Rejected:** Reading an environment variable in `bin/app.ts` to set `postCliContext`: a
synth-mode branch in the app. `cdk ls`: skips bundling but prints no template and checks
nothing.
**Consequences:** `npm run synth` needs no credentials and no network. Its template has the
same resources and properties as a deploy's except the function's asset hash and the version
resource's logical ID, which derives from it. It omits the `AWS::CDK::Metadata` resource and
its conditions, which the CLI adds through context, and does not read `cdk.json` context,
which holds none. It needs `npm run build` first, for the UI asset.

## 54. The UI bucket narrows `isWebsite` instead of relaxing the compiler

**Date:** 2026-10-04
**Context:** aws-cdk-lib declares `Bucket.isWebsite` as a getter returning
`boolean | undefined` and `IBucket.isWebsite` as an optional `boolean`. Under
`exactOptionalPropertyTypes` a `Bucket` is therefore not an `IBucket`, so passing it to
`S3BucketOrigin.withOriginAccessControl` or `BucketDeployment` fails to compile.
**Decision:** The stack's bucket is a file-local `UiBucket extends Bucket` whose `isWebsite`
getter returns `super.isWebsite ?? false`. aws-cdk-lib's consumers test the property for
truthiness or pass it to `fromBucketAttributes`, whose default is `false`, so the narrowing
changes no behavior; the synthesized template is identical with and without it.
**Rejected:** Turning off `exactOptionalPropertyTypes` in `infra/`: relaxes section 9. An
`as IBucket` cast: forbidden by AGENTS.md. Importing the bucket by name: loses the bucket
policy the origin access control adds.
**Consequences:** `infra/` keeps every strict option. Another aws-cdk-lib construct with the
same mismatch would need the same treatment.

## 55. Viewer TLS is CloudFront's default for its own certificate

**Date:** 2026-10-04
**Context:** `design/infrastructure.md` asked for a TLS 1.2 minimum. The distribution has
no custom domain, so it serves the `*.cloudfront.net` certificate, whose security policy
CloudFront fixes at TLSv1; `minimumProtocolVersion` takes effect only with a custom
certificate, and aws-cdk-lib ignores it otherwise with a warning.
**Decision:** The stack sets no minimum protocol version. HTTP/2 and HTTP/3 stay enabled.
**Rejected:** Setting `minimumProtocolVersion` anyway: it does nothing and reads as if it
did. A custom domain and ACM certificate in us-east-1: needs a domain the repository does
not own, and decision 26 already keeps the deployment to one command without one.
**Consequences:** A viewer can negotiate TLS 1.0 or 1.1 with the default domain. A
deployment with a custom domain sets `certificate`, `domainNames`, and
`minimumProtocolVersion: TLS_V1_2_2021`. The README states this. A custom domain is listed
as a next step.

## 56. The distribution accepts only GET and HEAD

**Date:** 2026-10-04
**Context:** The API serves only `GET` and `HEAD` (and `OPTIONS` for CORS preflights,
which no client of this API triggers, since the SDK sends no custom request headers).
Architecture §7 maps an unsupported method on a known path to 405 `method_not_allowed`.
CloudFront's default behavior allows `GET` and `HEAD` and answers other methods itself
with 403.
**Decision:** Keep the API behavior at `ALLOW_GET_HEAD`, so the edge accepts only the
methods the service implements. The 405 contract holds for the local server.
**Rejected:** `ALLOW_ALL` at the edge so the service's 405 answers: CloudFront's origin
access control for function URLs signs a request body only when the client sends its
SHA-256 in `x-amz-content-sha256` ("Restrict access to an AWS Lambda function URL
origin"), so a POST or PUT without it would be refused by the function URL's IAM auth
before the app runs. That trades one non-405 answer for another, and widens the edge
surface to methods the service never accepts.
**Consequences:** Clients of the deployed service see CloudFront's 403 (not problem
details) for unsupported methods. The OpenAPI document's 405 responses describe the
service, not the edge.

## 57. An address denial names a category, not the resolved address or its range

**Date:** 2026-10-04
**Context:** `design/url-policy-and-fetching.md` had `checkAddresses` deny with the blocked
address in `detail`, and the 403 problem carried that detail to the caller. Inside a VPC,
where names resolve to internal addresses, that hands any caller the internal DNS answer for
any name it chooses. An embedding-prefix address leaked the same way through the embedded
IPv4 address the detail named.
**Decision:** An address denial's detail is the fixed category `Host <hostname> resolves to
a private or reserved address.`, for embedding prefixes too, naming neither address nor
range. The range that matched travels in the decision's `range` field and is logged on the
fetcher's `info` denial line; the addresses stay in its `source resolved` debug line. A
resolution that is not an IP address is described as such without quoting it. An IP-literal
denial still names the literal, its embedded address, and its range, since all come from the
URL the caller or the upstream's `Location` supplied, not from DNS. Approved by the author
before implementation.
**Rejected:** Naming the range that matched (the first form of this fix): a range
still tells a caller which private plan an internal name lives in (`10.0.0.0/8` against
`172.16.0.0/12`), and a `/128` range such as `::1/128` is the address itself. A separate
sentence for embedding prefixes: with the range gone from the detail, the distinction tells
the caller nothing it can act on. Moving the address into the `info` denial line: the design
keeps resolved addresses at `debug`.
**Consequences:** An operator reads the range from the denial log line and the address with
`LOG_LEVEL=debug`. A caller learns only that the name resolves somewhere the service will not
fetch. The policy table's expected details and the decision's `range` field changed with
this entry.

## 58. A png spec carries no quality

**Date:** 2026-10-04
**Context:** `quality` is never passed to the PNG encoder, yet `toSpec` put it, given or
defaulted, into every spec, and the cache key and the ETag include the spec. `quality=10`
and `quality=90` on `format=png` therefore made two result-cache entries and two ETags for
identical bytes.
**Decision:** `TransformSpec` is a union on `format`: the `png` member has no `quality`, and
every other member, `source` included, has one. `toSpec` drops quality for png, and the key
writes `q=-` there, as it writes `-` for an absent dimension. The pipeline resolves the
output format and quality together into one value, so the PNG encoder cannot be handed a
quality by type. The SDK's `ProcessParams` is unchanged: it describes the request, not the
normalized spec. The key keeps its `v1` prefix: no new key can equal an old key with a
different meaning, and a bump would change the ETag of every non-png response too.
Approved by the author before implementation.
**Rejected:** Keeping `quality` in the spec and omitting it from the key only: the spec
would still claim a quality that means nothing. `quality: number | undefined`: the pipeline
would need a fallback for a lossy format with none, which cannot happen. Normalizing
`format=source` too: the key is formed before the fetch, when the output format is unknown.
**Consequences:** A `format=source` request on a png, TIFF, or GIF source still keys on
quality; decision 60 drops it from that request's ETag. CloudFront's cache key is the raw
query string, so the edge still keeps one entry per `quality` value; each is filled by
whichever instance serves it, and for `format=png` they now carry one ETag where they used
to carry one per `quality`.

## 59. Local-use NAT64, Teredo, benchmarking, and discard-only are blocked whole; IPv4-translated addresses are read

**Date:** 2026-10-04
**Context:** Decision 38 read `64:ff9b:1::/48` addresses at every RFC 6052 layout and
denied if any reading was blocked. That denied most of the prefix already, and still let
through an address public in all four readings, though the operator's actual layout is
unknown and its translator may reach internal IPv4 space. Teredo (`2001::/32`, RFC 4380)
and the IPv4-translated prefix (`::ffff:0:0:0/96`, SIIT, RFC 2765)
were not in the table at all, so an address in either passed regardless of the IPv4 address
it carried. Nor were IPv6 benchmarking (`2001:2::/48`, RFC 5180 as corrected by erratum
1752, which is the prefix the IANA special-purpose registry lists), though the IPv4 table
blocks its analogue `198.18.0.0/15`, and discard-only (`100::/64`, RFC 6666).
**Decision:** `64:ff9b:1::/48`, `2001::/32`, `2001:2::/48`, and `100::/64` are IPv6 ranges
in the blocked table, denied whole. `::ffff:0:0:0/96` joins the embedding prefixes and is
judged by the IPv4 table, as IPv4-mapped addresses are. The per-layout reading is removed:
every remaining embedding prefix carries its IPv4 address at one fixed position, so
`embeddedIpv4` returns at most one address. This supersedes the `64:ff9b:1::/48` part of
decision 38; its other two fixes (deny a non-IP resolution, drop the zone index) stand.
Approved by the author before implementation.
**Rejected:** Keeping the per-layout reading for `64:ff9b:1::/48`: it fails open on the
addresses it cannot classify. Decoding Teredo's server and obfuscated client addresses:
more code to reach a deprecated tunnelling scheme no image host needs.
**Consequences:** Any source reachable only through local-use NAT64 or Teredo, or with an
address in the benchmarking or discard-only prefix, is refused.
The policy table's per-layout rows are replaced by whole-range rows, including addresses in
each new range that passed before.

## 60. The ETag drops quality once an omitted format resolves to png

**Date:** 2026-10-04
**Context:** Decision 58 dropped quality from the spec for `format=png`, but with `format`
omitted the result-cache key is formed before the fetch, when the output format is unknown,
so a png, TIFF, or GIF source still had one ETag per `quality` value for identical bytes.
The ETag is computed after `loadSource`, when the sniffed type fixes the output.
**Decision:** `resolveEncoding(spec, sourceType)` moves from a private step of the pipeline
into `image/spec.ts`, with the source-to-output mapping, because the operation is its second
caller. When it resolves a `format=source` spec to png, the operation computes the ETag over
the key of the same spec with `format=png`, which has no quality. The result-cache key is
unchanged. Approved by the author before implementation.
**Rejected:** Resolving `format=source` in the ETag for every source: it would change the
ETag of every format-omitted lossy response for no gain. Looking up the result cache after
the fetch under a normalized key: it costs a fetch on every hit, which the cache exists to
avoid.
**Consequences:** A format-omitted png source and an explicit `format=png` request share an
ETag, which is correct since their bytes are identical. The result cache still keeps one
entry per `quality` value for such sources, and reports `miss` for a second quality. Each
existing format-omitted png ETag changes once.

## 61. Unknown query parameters are refused

**Date:** 2026-10-04
**Context:** The query schemas stripped keys they did not define, so `GET
/process?url=...&widht=5` answered 200 with the image untransformed, and because the
CloudFront cache policy keys on every query string, each extra parameter minted a new
cacheable entry for the same image.
**Decision:** The `/process` and `/info` query schemas are `z.strictObject`, carrying a
message built from the schema's own keys, `not accepted; use url, width, height, crop,
format, quality` on `/process` and `not accepted; use url` on `/info`, so the entry says
what is accepted as every other validation message does. Zod 4.6.5 reports the unknown
keys of one object as a single issue, `{ code: 'unrecognized_keys', keys: string[], path,
message }`, and the validation hook writes one `errors` entry per key, so the problem names
each parameter rather than the query as a whole. Approved by the author before implementation.
**Rejected:** Ignoring unknown parameters (the previous behavior): a typo succeeds silently.
Stripping them at the edge with a CloudFront Function: fixes the cache keys but not the
silent typo, and adds an edge component. Rejecting only near-misses of known names: a
guess, and still mints keys for anything else.
**Consequences:** Unknown parameters, including a known name in another case and the spill
of an unencoded source URL's own query string (`url=...?w=10&h=20` names `h`), are 400 and
never fetched. The SDK and the UI are unaffected, since they build URLs only from known
parameters. A pair with an empty name (`&=5`, `&&`, a trailing `&`) is dropped by Hono's
query parser (`hono/dist/utils/url.js`, `if (name === "") continue`) before validation, so
it is not refused; the raw query is not inspected for it. Adding a parameter to the contract
now also makes it acceptable, so an older deployment refuses a newer client's parameter
instead of ignoring it. The OpenAPI document is unchanged: zod-to-openapi enumerates query
parameters from the shape, and the generated document is byte-identical before and after.

## 62. The OpenAPI document lists the headers the service sets

**Date:** 2026-10-04
**Context:** The OpenAPI document described no response headers, so a client generated from
it could not learn about `ETag`, `X-Request-Id`, the `X-Image-*` headers, or the rate-limit
headers.
**Decision:** Every documented response lists the headers the service sets on it, each with
a description, and with a `const` or `enum` where the service fixes the value. Decision 46's
mechanism is extended to headers: one function in `http/openapi.ts` builds the headers of
every problem response, component or inline, adding `Retry-After`, `RateLimit`, and
`RateLimit-Policy` where `rate_limited` is among its codes and `Allow` where
`method_not_allowed` is. `Content-Type` is documented by each response's content map and
not under `headers`, because OpenAPI 3.1.0, Response Object, says of `headers`: "If a
response header is defined with the name "Content-Type", it SHALL be ignored."
`Content-Length` on the `/process` 200 is listed as not required, since a streamed
response may arrive chunked without it (architecture §7). Headers the transport adds (the
Node server, the function URL, CloudFront: `Date`, `X-Cache`, `X-Amz-Cf-Id`) are not the
service's and are left out. `Access-Control-Expose-Headers` is described in prose rather
than with a `const`, because its list lives in `app.ts`, which imports `http/openapi.ts`, so
importing the list back would form a cycle.
**Rejected:** Listing `Content-Type` under `headers` as well: spec-conformant tools ignore
it. Declaring the headers with Zod objects: registered response components bypass
zod-to-openapi's generator, so the components and the inline responses would be written two
ways. Moving the CORS configuration to its own module to share the exposed list: a
restructuring beyond documenting headers.
**Consequences:** A test compares, for each kind of response, the documented header set and
its fixed values with the headers a real request receives, so a header added to or removed
from a route without the document fails it.

## 63. Integer parameters accept only plain decimal digits

**Date:** 2026-10-04
**Context:** `width`, `height`, and `quality` were `z.coerce.number().int()`, which runs
`Number()` on the string, so `05`, `5.0`, `0x5`, `5e0`, `+5`, and ` 5` all read as 5. The
CloudFront cache policy keys on the raw query string, so each spelling was another cache
entry and origin request for one result, which undercut decision 61.
**Decision:** Each integer parameter is `z.preprocess` into
`z.number().int().min(min).max(max)`. The preprocess converts a string only when it
matches `^(0|[1-9]\d*)$` and otherwise leaves it a string, which the number check refuses
with the parameter's one message, now `must be an integer between <min> and <max>, written
as digits without a sign or leading zeros`. The pattern admits `0`, although no parameter
accepts it, so the spelling rule stays the canonical form of any non-negative integer and
the range stays the only rule about values; `0` is refused by `min(1)` with the same
message, so the two patterns behave identically here and this one needs no change if a
range ever starts at 0.
**Rejected:** `z.string().regex(...)` piped into the number schema: zod-to-openapi documents
such a pipe by its input, so the parameters would appear as strings with a pattern, not
integers with a range (`collectMetadata` follows a pipe's `in` unless it is a transform).
`z.coerce.number()` with a refinement: the refinement sees the coerced number, not the
spelling. A second message for a bad spelling: one sentence per parameter already says what
is accepted.
**Consequences:** The generated OpenAPI document is unchanged (byte-identical before and
after). The message of every integer parameter changed, so the UI shows the longer sentence
and the e2e expectation changed with it. The SDK is unaffected: `processUrl` writes
integers with `String(n)`, which gives plain digits for every integer in range, and its
fixed-order test pins `width=300&height=200&...&quality=70`. Other spellings that remain
distinct cache keys, such as the parameter order and the percent-encoding of the source URL,
are left to the listed next step, a CloudFront Function canonicalizing the query.
