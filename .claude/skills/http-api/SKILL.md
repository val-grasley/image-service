---
name: http-api
description: "Use when adding or changing an endpoint, query parameter, response header, error code, or status mapping in apps/api/src/http/ or operations/, or when touching the OpenAPI document."
paths:
  - apps/api/src/http/**
  - apps/api/src/operations/**
  - apps/api/src/app.ts
  - apps/api/src/errors.ts
---

# HTTP API

The contract is `docs/architecture.md` section 7. Assembly, schemas, the type lock, error
mapping, middleware order, and the test plan are `docs/design/http-api.md`. The SDK
(`docs/design/sdk.md`) owns the parameter types and the error code union; the API's
schemas are locked to them, so a change touches both or neither.

## Adding or changing a parameter

1. Add it to `ProcessParams` in `packages/sdk/src/transform.ts` and to the canonical URL
   builder's fixed order.
2. Add it to the route's Zod schema. The `expectTypeOf` lock in `process-query.test.ts`
   fails to compile until both sides agree.
3. Add it to `TransformSpec` and to `cacheKey` if it affects output; bump the key's version
   prefix if the key format changes.
4. Describe it in the route's OpenAPI metadata: type, range, default, one sentence.
5. Tests per the design document's plan, plus: the validation message names the field and
   says what is accepted.
6. Update the parameter table in section 7.

## Adding an error code

1. Add the code to `ERROR_CODES` in `packages/sdk/src/errors.ts`; `ErrorCode` derives from it.
2. Add its row to the status table in `http/errors.ts`. A new status needs a decision-log
   entry and a row in section 7.
3. Register it in the OpenAPI responses of every route that can produce it, and in the
   `/docs` error list that `type` links into.
4. Test it through `toProblem` per the design document's `errors.test.ts` plan.

## Rules this skill adds

- `ServiceError` is the only error domain modules throw; routes never build responses from
  anything else.
- Response headers come from the operation result, never from the fetch result.
- `z.url()`, not the deprecated `z.string().url()`, which fails `no-deprecated`.
- `app.doc31`, not `app.doc`. HEAD is handled by Hono's dispatch and never registered.
- `checkUrl` runs in the operations before any cache lookup (design document, "Routes").
