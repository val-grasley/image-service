# AGENTS.md

Rules for any agent working in this repository. This file is loaded on every turn, so it
holds only what applies to every task. Area-specific guidance lives in `.claude/skills/` and
loads when relevant. `CLAUDE.md` imports this file; do not duplicate content between them.

## What this is

An image processing service: `GET /process` fetches an image from a caller-supplied URL,
resizes and re-encodes it, and returns it. A single-page UI exercises the API through a
TypeScript SDK. It deploys to AWS Lambda behind CloudFront via CDK and runs locally with no
AWS account.

Read `docs/architecture.md` before anything else. It fixes the deployment shape, the
directory tree, the request lifecycle, the fetch policy, the public contract, and every limit.
`docs/decisions.md` says why. `docs/design/` holds one design document per subsystem; read
the one for the subsystem you are changing before you change it.

## Commands

| Task | Command |
|---|---|
| Install | `npm ci` |
| Run API and UI locally | `npm run dev` |
| Build everything | `npm run build` |
| Unit and integration tests | `npm test` |
| End-to-end tests | `npm run test:e2e` |
| Typecheck, lint, format check, tests | `npm run preflight` |
| Synthesize infrastructure | `npm run synth` |

`npm run preflight` is the gate before any commit once the scaffold exists. It is the same
set of checks in every environment; there is no separate CI.

## Documents are the source of truth

- The architecture and design documents govern. If an implementation must differ, the kind
  of difference decides what happens. A change that adds detail or fills an omission rides in
  the same commit with a decision-log entry. A change that removes or relaxes a rule, limit,
  seam, or status code is proposed to the author first and implemented only after approval.
  The change summary states which kind each document change is. Never diverge silently.
- If a document cannot be implemented as written, stop and say so. Do not implement a
  different design and describe it afterwards.
- A new file in a directory whose statement in `docs/architecture.md` section 3 does not
  cover it, or a new directory, is allowed only after that tree is extended with a one-line
  statement of what belongs there.
- A new runtime dependency gets a decision-log entry. A new dev dependency gets a sentence in
  the commit body.

## Structure

These four are the rules most often broken, in the order they matter.

**Comments.** A comment states a why that the code cannot. No comments that narrate what the
code does, no section banners, no doc comments on functions whose signature already says
everything. The exception is the SDK's public surface, where doc comments are the product.

**Boundaries.** A function, type, or module boundary exists for one of four reasons:

1. There is a named semantic step a reader would say out loud.
2. There is a seam between pure logic and I/O.
3. The design document says this must be testable in isolation.
4. There is a genuine second caller.

Length is never a reason to split. "Might be reused" is never a reason to extract. The
change summary lists every new exported function, type, and module with the number that
justifies it. An export with no importer outside its file is a defect, except in the SDK's
public surface and in entry points a runtime or tool imports by name, such as the Lambda
`handler`. The design documents name the seams; a new one needs the document updated in the
same commit.

**No shortcuts.** Each of these is a defect, not a judgment call. Inside `apps/api/src`:
calling `fetch` or `undici` outside `source/fetcher.ts`; importing `sharp` outside
`image/pipeline.ts` (test files are exempt, for reading metadata back); reading
`process.env` outside `config.ts`; writing to `console` outside `observability/logger.ts`.
Everywhere: a test-only branch in production code; a hardcoded value that config owns; an
inline lint or type suppression; a skipped, weakened, or assertion-free test; changing a
test's expected value without a stated behavior change; a phrase like "simplified for now"
or "TODO" without a decision-log entry behind it. Outside `apps/api/src` the seams do not
apply: the SDK client uses `fetch`, the fake upstream uses `sharp`, and `apps/web/build.ts`,
`infra/`, and the fake upstream use `process.env` and `console` as they need.

**Filesystem.** Directories are named for subsystems and files for the concept they contain,
per the tree in `docs/architecture.md`. Types live beside their first use. There is no
`utils`, `helpers`, `common`, `misc`, `shared`, or `types` file anywhere; the SDK's
`index.ts` is the only barrel. A file past about 300 lines is a smell to report in the
change summary, not a reason to split mechanically.

## Code

- TypeScript strict, ESM only, `node:` prefix on built-in imports, `erasableSyntaxOnly`
  (no enums, no parameter properties). Union literal types where an enum would have been.
  Named exports only, except tool configuration files that require a default export
  (Vitest, Playwright, ESLint).
- Catch variables stay `unknown`; never annotate them otherwise. No `any`, no non-null
  assertions, no `as` casts to satisfy the compiler. If the types are wrong, fix the types.
- Discriminated unions for states and results. Exhaustive `switch` checked with `never`.
- The SDK's parameter types and error-code union are the source of truth for the public
  contract; the API's Zod schemas are typed against them, by the mechanism the HTTP design
  document fixes. For shapes the SDK does not own, such as config and internal results, the
  Zod schema is the source and the type is inferred from it. No shape is declared twice.
- No defensive noise: no null checks on values the types guarantee, no try/catch that
  swallows, no re-validation of data already validated at the boundary.
- Errors are wrapped with `cause` preserved. Never stringify an error into a new message
  and rethrow.
- `config.ts` fails at startup on an invalid value, or on a missing value that
  `docs/architecture.md` section 8 gives no default. A required value never falls back to a
  default silently.
- Anything that compares timestamps (caches, the rate limiter) takes a clock as a
  collaborator so tests pass a time instead of sleeping. Timeouts are tested against the
  fake upstream's delayed responses.
- No dependency for a problem ten lines solve. No reimplementing what Node 24 ships:
  `URL`, `node:net` including `BlockList`, `node:crypto`, `node:stream`.
- Logging goes through `observability/logger.ts`. Log hostnames, never full URLs, since
  source URLs can carry tokens in their query strings. Never log request bodies or image bytes.
- Every limit comes from `config.ts`. The limits table in `docs/architecture.md` section 8
  and the README change together with any default.
- Touch only what the task needs. No reformatting of untouched code, no drive-by renames.

## Tests

- Test behavior through public surfaces: the app's request method, pure functions, the SDK's
  public API. Never through private internals.
- No test touches the network. No image bytes are checked in; every image in a test comes
  from `packages/fake-upstream`, over HTTP or from its exported generator. Do not mock
  `sharp`, `undici`, or the fetcher.
- Table-driven tests for the fetch policy, the spec parser, and the error mapping.
- Every bug fix lands with the test that would have caught it.
- Test names state the behavior, not "should work" or "handles edge cases".
- Coverage is reported, not gated. Do not write tests to move a number.

The `testing` skill has the mechanics.

## Security posture

- Every outbound request goes through `source/fetcher.ts` and therefore through the policy in
  `docs/architecture.md` section 5. There is no exception for "trusted" hosts in code.
- Upstream headers are never forwarded to the client. Upstream `Content-Type` is never
  trusted; the sniffer decides.
- Text from the API or the user reaches the DOM through `textContent` or attribute setters,
  never `innerHTML`.
- No secrets anywhere in the repository, including tests and infrastructure.

## Workflow

**Scope.** Implement the task as scoped. Ideas for more go in the change summary, not in the
code. Do not narrow scope to finish faster; if part of a task is blocked, finish the rest and
say exactly what is left and why.

**Verification.** Run `npm run preflight` before reporting a task done, and say what ran and
what it reported. Never claim tests pass without having run them in this session. If
something fails, report the output; do not describe it as passing with caveats.

**Library facts.** Before using any sharp, Hono, undici, CDK, or AWS SDK option, read its
type definition in `node_modules` or its documentation. Never guess an option name or
default. If a claim about a library or AWS behavior matters to the design, verify it and say
how.

**Blocked or uncertain.** Stop and ask. A wrong guess costs more than a question.

## Commits

Nothing is committed without the author's explicit approval of the boundary and the message.
The sequence is:

1. Finish the change. Run preflight (the `preflight` skill).
2. Write the change summary in the shape the `preflight` skill gives.
3. Request an adversarial review from a fresh-context agent that did not write the change:
   never a forked agent, which inherits the implementer's reasoning. The spawning prompt
   tells it to read `.claude/skills/adversarial-review/SKILL.md` first and gives it the diff,
   the change summary, the task statement, the commit's place in the planned sequence, and
   the governing documents.
4. For every numbered finding, either make the change or dispute it back to the same
   reviewer with evidence: a reproduced run, a type definition, a document line. Re-run
   preflight and send the delta together with the full current diff; later rounds review
   what changed, consult the full diff only to confirm each fix is complete and consistent,
   and report anything else they happen to see. The loop ends when the reviewer's verdict is
   that no further changes are needed. A finding still disputed after the reviewer re-reads
   it goes to the author with the proposed commit, marked unresolved. After three rounds
   without a clean verdict, the whole exchange goes to the author.
5. The reviewer's "Decisions I would revisit" section is never acted on; it goes to the author
   with the proposed commit.
6. Propose the commit boundary and full message to the author. Commit only on approval.

**Message format.** `type(scope): subject`, imperative, under 72 characters. Types: `feat`,
`fix`, `docs`, `test`, `chore`, `refactor`. Scopes: `api`, `web`, `sdk`, `upstream`, `infra`,
`e2e`, or none for repository-wide changes. The body says why and what was considered, in a
few lines, and never restates the diff. The author's attribution trailers are appended as
configured for the session.

**Granularity.** One logical change per commit. Every commit after the scaffold passes
preflight. A document change forced by the code rides in the same commit. No amend, no
rebase, no force push; a mistake is fixed by a following commit that says so.

**Planned sequence.** Each line is one commit; the author may split or merge them.

1. Architecture document and decision log
2. AGENTS.md, CLAUDE.md, and the process skills (`preflight`, `adversarial-review`)
3. Design documents under `docs/design/`
4. Subsystem skills, reconciled against the design documents
5. Workspace scaffold: tooling, lint, typecheck, `config.ts`, `observability/logger.ts`,
   and their tests
6. SDK: transform types, error codes, canonical URL builder
7. API: fetch policy with its test table
8. API: fetcher and sniffer, and the fake-upstream package
9. API: image pipeline
10. API: `operations/`, routes for `/process`, `/info`, and `/health`, validation,
    problem-details errors, request-id and loop-guard middleware, the local entry
11. API: caching headers, ETag, result and source caches
12. API: rate limiter with memory and DynamoDB implementations, and its middleware
13. API: OpenAPI document and docs route
14. SDK: client
15. UI
16. End-to-end suite
17. Infrastructure: CDK stack and the Lambda entry
18. README
