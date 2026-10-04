---
name: url-safety
description: "Use when changing anything under apps/api/src/source/ (policy, fetcher, sniffer, source cache), adding any code path that reaches the network, or adding a config variable that affects which URLs are fetched."
paths:
  - apps/api/src/source/**
  - apps/api/test/fetcher.test.ts
---

# URL safety

The rules are `docs/architecture.md` section 5 and are normative. The interfaces, the
mechanics under "fetcher.ts" and "policy.ts", and the required test table are
`docs/design/url-policy-and-fetching.md`. Read both before changing anything here.

## Rules this skill adds

- A rule change changes rows in the design document's test table in the same commit. A
  removed row needs a decision-log entry.
- `policy.ts` stays pure. `checkUrl(url, previous, policy)` and
  `checkAddresses(url, addresses, policy)` are its only exported functions; if a change
  needs I/O it belongs in the fetcher.
- New fetch capability (HEAD, ranges, retries) is added inside `fetcher.ts`, not beside it.
- `ALLOWED_HOSTS` and `PUBLIC_HOSTS` are the only host-based exemption and refusal. Do not
  add a third list, and do not add an `allowPrivate` switch.

## Pitfalls the design document explains

Read its "policy.ts" section for the `BlockList` family argument and `embeddedIpv4`, and
its "fetcher.ts" section for the `options.all` lookup shape, `maxRedirections: 0`, the
per-hop `Agent`, and why `request` is used instead of `fetch`. Each of these has failed
silently for someone; none can be inferred from the undici or Node documentation alone.

## Tests

The design document's test table is the minimum. Address-rule tests inject the resolver;
redirect, byte, encoding, and timeout tests run against `packages/fake-upstream`. A test
that a private resolution produces no TCP connection reads the fake's connection records.
