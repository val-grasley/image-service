---
name: preflight
description: Use before declaring any task done and before requesting adversarial review. The implementer's self-check: run the gates, then walk the structure and document-sync checklist, then write the change summary.
---

# Preflight

Run this before saying a task is done. It has three parts, in order.

## 1. Gates

```
npm run preflight
```

Format check, lint, typecheck, unit and integration tests. If `infra/` changed, also
`npm run synth`. If anything under `apps/`, `packages/`, or `e2e/` changed, also
`npm run test:e2e`, since there is no other place a UI-visible regression from an API or
SDK change is caught. All must pass. Report the actual output in the change summary; do not
summarize a failure as a pass.

## 2. Walk the diff

Read `git diff` top to bottom and answer each of these honestly.

**Comments.** Does every comment state a why the code cannot? Delete any that narrate, any
banners, any doc comments on self-explanatory signatures.

**Boundaries.** For every new exported function, type, or module: which of the four numbered
reasons in AGENTS.md justifies it? Record the number in the change summary. If none, inline
it. Does every export have an importer outside its file, other than the SDK surface and
runtime entry points? For every new seam: is it in the design document?

**Shortcuts.** Inside `apps/api/src`, search the diff for: `fetch(` or `undici` outside
`source/fetcher.ts`; `sharp` outside `image/pipeline.ts` and test files; `process.env`
outside `config.ts`; `console.` outside `observability/logger.ts`. Everywhere, search for:
`eslint-disable`; `@ts-ignore` or `@ts-expect-error`; `as any`; `!` non-null; `.skip`;
`.only`; `retry` in a Vitest config; `NODE_ENV`, `isTest`, or `vitest` in a non-test file
under any `src/`; `TODO`; `FIXME`; `for now`; `simplified`; `export default` outside a
tool configuration file; a literal number that `docs/architecture.md` section 8 owns; an
existing test whose expected value changed.

**Filesystem.** Is every new file in a directory whose statement in the architecture tree
covers it? Is any file named `utils`, `helpers`, `common`, `misc`, `shared`, or `types`? Is
any file past 300 lines?

**Types.** Any `any`, any cast, any annotated catch variable, any switch without exhaustive
check, any shape declared twice?

**Tests.** Does each new behavior have a test that fails when the behavior is removed? Does
any test assert nothing, or assert on a mock? Does any test touch the network or sleep?

**Security.** Any new outbound path? Any upstream header reaching a response? Any full URL in
a log line? Any `innerHTML`?

**Scope.** Is anything in the diff not needed by the task? Remove it and mention it in the
summary as a follow-up.

## 3. Document sync

For each of these, either confirm no change is needed or make the change in this commit:

- `docs/architecture.md`: the tree (new files or directories), section 7 (contract), section
  8 (limits), section 11 (document status).
- The design document for the subsystem touched.
- `docs/decisions.md`: any divergence from a document, any new runtime dependency, any new
  status code.
- README: the limits table, the commands, the endpoint list.

State for each document change whether it adds detail or relaxes a rule; the second kind
needs the author's approval before implementation, per AGENTS.md.

## Change summary

Write it for the reviewer and the author, in this shape:

- **Task**: the task statement as given, and the commit's place in the planned sequence.
- **What changed** in two or three sentences.
- **Why**, with the document section it implements.
- **New boundaries**: each new exported function, type, and module with its reason number.
- **Verified**: the commands run and their result.
- **Left out** and why, if anything.
- **Documents changed**, each marked as adding detail or relaxing a rule.
- **Flags**: files past 300 lines, follow-ups noticed.
- **Proposed commit**: the subject line and body.
