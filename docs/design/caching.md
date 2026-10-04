# Design: caching

Implements the caching parts of `docs/architecture.md` sections 2, 4, and 7 and decision 11.
Three things are cached: processed results (per instance), fetched sources (per instance),
and processed results at CloudFront via headers. This document fixes the in-process pieces
and the ETag computation. CloudFront configuration is in `design/infrastructure.md`.

## ByteLru

`apps/api/src/cache/lru.ts`. One generic store used by both in-process caches, which is the
second caller that justifies it.

```ts
class ByteLru<V> {
  constructor(options: { maxBytes: number; ttlMs: number; sizeOf: (v: V) => number; clock: Clock });
  get(key: string): V | undefined;   // drops and returns undefined if expired
  set(key: string, value: V): void;  // evicts least recently used until within budget
  delete(key: string): void;
  readonly bytes: number;
}
```

`Clock` is `{ now(): number }` (milliseconds). A value larger than `maxBytes` is not stored.
Insertion order is a `Map`; `get` re-inserts to mark recency. Expiry is checked on `get`
only; no timers.

## ResultCache

`apps/api/src/cache/result-cache.ts`.

```ts
type CachedResult = {
  bytes: Uint8Array;
  contentType: string;
  width: number;
  height: number;
  format: OutputFormat;
  etag: string;
};

interface ResultCache {
  get(key: string): Promise<CachedResult | undefined>;
  set(key: string, value: CachedResult): Promise<void>;
}

class MemoryResultCache implements ResultCache { ... }  // ByteLru with RESULT_CACHE_* limits
```

Async by interface so a shared store can replace the memory implementation without touching
callers (the documented next step). The memory implementation resolves immediately.

## Cache key

The key is the canonical form of the transform spec plus the source URL, produced by
`image/spec.ts`:

```
v1|url=<href as requested>|w=<n|->|h=<n|->|crop=<mode>|format=<fmt|source>|q=<n>
```

Parameters appear in this fixed order with defaults applied, so equivalent requests share a
key. The leading `v1` is bumped if the key format changes. `url` is the href as received,
not the redirect target, so two source URLs that redirect to the same place are two entries;
this is correct because their upstream validators may differ.

## ETag

Strong, computed in `operations/process-image.ts`:

```
etag = '"' + hex(sha256(cacheKey + '|' + pipelineVersion + '|' + sourceIdentity)).slice(0, 32) + '"'
```

- `pipelineVersion` is `sharp.versions.sharp + '/' + PIPELINE_REVISION`, where
  `PIPELINE_REVISION` is a constant in `image/pipeline.ts` bumped whenever output for the
  same input changes (an encoder option, a crop semantics fix).
- `sourceIdentity` is, in order of preference: the upstream `ETag` as received; else
  `lm:` plus the upstream `Last-Modified`; else `sha256:` plus the hash of the source bytes.

The ETag therefore changes when the request changes, when the pipeline changes, or when the
source changes, and is stable otherwise.

## Lifecycle in the operation

```ts
type ProcessOutcome =
  | { kind: 'image'; result: CachedResult; fromCache: boolean }
  | { kind: 'not_modified'; etag: string };

// operations/deps.ts; app.ts's AppDeps extends it, so the dependency flows inward
type OperationDeps = {
  fetchSource: BoundFetch;
  sourceCache: SourceCache;
  resultCache: ResultCache;
  pipeline: { inspect; transform; pipelineVersion };
  policy: PolicyConfig;
  limits: Pick<Config, 'maxInputPixels' | 'maxOutputBytes' | 'transformTimeoutSeconds'>;
};
// the per-request logger is passed as a separate argument so deps are built once

function processImage(spec: TransformSpec, ifNoneMatch: readonly string[], deps: OperationDeps, log: Logger): Promise<ProcessOutcome>;
```

0. `checkUrl(spec.url, undefined, deps.policy)`; throw its denial.
1. `resultCache.get(key)`. On hit: if `ifNoneMatch` matches the stored ETag, return
   `not_modified`; else return the image with `fromCache: true`.
2. `sourceCache.get(href)` or `fetchSource`. Store on fetch.
3. Sniff, inspect, bound (section 4 steps 8).
4. Compute the ETag. If `ifNoneMatch` matches, return `not_modified` without transforming.
5. Transform, build `CachedResult`, `resultCache.set`, return the image with
   `fromCache: false`.

`ifNoneMatch` matching: the header is split on commas, each entry trimmed; a `W/` prefix is
stripped (weak comparison is acceptable for a 304 on GET); `*` matches any. The route
parses the header into the list; the operation only compares strings.

## Response headers

| Header | Value |
|---|---|
| `ETag` | as above |
| `Cache-Control` | `public, max-age=<RESULT_CACHE_TTL_SECONDS>` on image responses |
| `X-Result-Cache` | `hit` or `miss`; `hit` only when the bytes came from `ResultCache` |

304 responses carry `ETag`, `Cache-Control`, and `X-Request-Id` and no body. Error
responses carry `Cache-Control: no-store`. Non-image routes carry the values in section 7.

`HEAD /process` runs the full operation and discards the body, so its headers and ETag are
exactly those of the GET.

## Tests

- `ByteLru`: eviction order; a value larger than the budget is rejected; TTL expiry with an
  injected clock; `get` refreshes recency; `bytes` accounting after delete and eviction.
- ETag: identical for repeated requests against the `/with-validators` fixture; changes when
  the spec changes, when the upstream `ETag` changes, and when `PIPELINE_REVISION` changes
  (the constant is injectable in tests through the pipeline's deps); falls back to the bytes
  hash when the fixture has no validators and changes when the bytes change.
- Conditional requests: `If-None-Match` matching on a result-cache hit returns 304 without
  calling the fetcher (the fake's request log is empty); on a miss with an upstream
  validator, returns 304 after one fetch and without a transform (the pipeline dep records
  calls); a non-matching value returns 200.
- `X-Result-Cache` is `miss` then `hit` for two identical requests on one app instance.
- Error responses carry `no-store`; `/health` carries `no-store`; `/info` carries the
  source-cache max-age.
