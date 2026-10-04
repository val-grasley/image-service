---
name: testing
description: "Use when writing or changing any test: unit tests beside the code, integration tests in apps/api/test/, the fake-upstream package, or the Playwright suite in e2e/."
paths:
  - "**/*.test.ts"
  - apps/api/test/**
  - packages/fake-upstream/**
  - e2e/**
---

# Testing

The philosophy is in AGENTS.md; the fake upstream is `docs/design/fake-upstream.md`; each
design document ends with its own test plan, which is the minimum for that subsystem.

## Where tests live

| Kind | Location | Runs against |
|---|---|---|
| Unit | `*.test.ts` beside the module | One module and its direct collaborators |
| Integration | `apps/api/test/` | The Hono app in-process via `app.request()` |
| End-to-end | `e2e/tests/` | The built UI and a local API in Chromium |

Test files are typechecked by `tsc -b` through each workspace's `tsconfig.json`, so a type
error in a test fails preflight. Type-level locks use Vitest's `expectTypeOf`.

## Config in tests

`testConfig(overrides)` in `apps/api/test/` returns a `Config` with small limits; the fake
upstream's address is passed as `allowedHosts`. Tests never set `process.env`; lint
forbids it in test files too.

## Table-driven tests

```ts
const cases: { name: string; url: string; expect: Decision }[] = [...];
for (const c of cases) {
  it(c.name, () => expect(checkUrl(new URL(c.url), undefined, policy)).toEqual(c.expect));
}
```

The `name` says the behavior. The expectation is the full value, not a boolean, so the
denial reason is checked too.

## Asserting on responses

Decode image bodies with sharp and assert on dimensions and format; never compare bytes.
Use role and label locators in Playwright, never CSS classes.

## Running

- One file: `npx vitest run path/to/file.test.ts`
- One test: `npx vitest run -t "name fragment"`
- End-to-end: `npm run test:e2e`; `npx playwright test --ui` to debug.

## What not to do

- No `vi.mock` of `sharp`, `undici`, or the fetcher.
- No snapshot of whole responses or the whole OpenAPI document.
- No `setTimeout` waits; timeouts are exercised through the fake's `/slow` and
  `/slow-headers` routes with small configured budgets.
