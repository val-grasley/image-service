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
