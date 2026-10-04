# Design: rate limiting

Implements `docs/architecture.md` section 4 step 3 and section 8, and decisions 12 and 28.
Directory: `apps/api/src/rate-limit/`.

## Interface

```ts
type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;  // seconds until the current window ends
};

interface RateLimiter {
  consume(key: string, nowMs: number): Promise<RateLimitDecision>;
}
```

One call per request. The caller passes the clock's time so the limiter has no clock of its
own and tests pass a time.

## Algorithm: fixed window

Window length 60 s, aligned to the minute: `window = floor(nowMs / 60000)`. The counter for
`key:window` is incremented; the request is allowed if the incremented count is at most
`RATE_LIMIT_PER_MINUTE`. `resetSeconds` is the time to the next window boundary.

A fixed window admits up to twice the limit across a boundary. A sliding window or token
bucket avoids that at the cost of either two reads per request or a read-modify-write that
needs a conditional update in DynamoDB. For a per-IP limit of 60 whose purpose is to bound
abuse rather than to meter precisely, the boundary burst is accepted (decision 32).

## Memory implementation

`memory.ts`: a `Map<string, number>` keyed by `key:window`. On every `consume`, entries
whose window is older than the current one are deleted, which bounds the map to the active
window's keys. Used locally and in tests.

## DynamoDB implementation

`dynamodb.ts`. Table shape:

| Attribute | Type | Role |
|---|---|---|
| `pk` | string | partition key, `rl#<key>#<window>` |
| `count` | number | |
| `expiresAt` | number | TTL attribute, epoch seconds, window end plus 120 s |

One `UpdateItem` per request:

```
UpdateExpression: ADD #count :one SET expiresAt = if_not_exists(expiresAt, :exp)
ReturnValues: UPDATED_NEW
```

The returned `count` decides. No read before write, no conditional expression, so the
operation is a single round trip and is correct under concurrency because `ADD` is atomic.

The client is injected as `Pick<DynamoDBClient, 'send'>`; tests pass a fake whose `send`
records the command and returns a chosen count. The real client is constructed in `app.ts`
from the default credential chain and `RATE_LIMIT_TABLE`.

**Failure mode.** If the `UpdateItem` fails or times out (`send(command, { abortSignal:
AbortSignal.timeout(500) })`), the limiter
logs at `error` and allows the request. The service fails open because reserved concurrency
already bounds the damage and a DynamoDB outage should not take the service down with it
(decision 32).

## Scope

The middleware is attached to `/process` and `/info` only. `/health`, `/openapi.json`,
`/docs`, and unknown paths are not limited; they do no work worth protecting.

## Client identity

`http/middleware/rate-limit.ts` derives the key:

| `CLIENT_IP_SOURCE` | Source |
|---|---|
| `socket` | `c.env.incoming.socket.remoteAddress` from `@hono/node-server`'s bindings; under the Lambda adapter this yields no address |
| `x-forwarded-for` | the entry `TRUSTED_PROXY_COUNT` from the right of `X-Forwarded-For` |
| `cloudfront` | `CloudFront-Viewer-Address` with the port removed by splitting on the last colon and stripping brackets |

An IPv6 address is masked to its /64 before use as the key. If the configured source yields
no address (header missing), the key is `unknown` and the request is limited as one shared
client, which fails closed rather than open. Hono's `getConnInfo` is not used.

## Response

On denial the middleware throws `ServiceError('rate_limited')` with the decision attached;
the error mapping produces 429 with:

```
Retry-After: <resetSeconds>
RateLimit: "default";r=0;t=<resetSeconds>
RateLimit-Policy: "default";q=<limit>;w=60
```

per draft-ietf-httpapi-ratelimit-headers. These headers appear only on 429 responses
(decision 12).

## Infrastructure

`design/infrastructure.md` creates the table: partition key `pk`, on-demand billing,
`expiresAt` as the TTL attribute, removal policy destroy. The function receives the L2
`grantWriteData`, which covers `UpdateItem` along with the other write actions; the
narrower hand-written policy is not worth departing from the grant helpers for.

## Tests

- Memory: the limit-th request is allowed and the next denied; a new window resets; old
  windows are purged; two keys are independent; `resetSeconds` is correct at the window
  start and one second before its end.
- DynamoDB: the command shape (expression, key, TTL value) is asserted from the fake's
  recorded input; count at the limit allows, above denies; a rejected `send` allows and logs.
- Middleware: each `CLIENT_IP_SOURCE` mode derives the expected key from crafted headers;
  the rightmost rule with `TRUSTED_PROXY_COUNT` 0 and 1; an IPv6 address masks to /64; a
  missing header yields `unknown`; 429 carries the three headers and `no-store`; 200
  responses carry none of the rate-limit headers.
