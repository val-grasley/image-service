---
name: adversarial-review
description: The brief for the independent reviewer that must sign off on every commit. Use when spawning a reviewer agent for a change, or when acting as that reviewer. Defines the inputs, what to hunt for, the output format, the verdict rule, and the dispute path.
---

# Adversarial review

Every commit needs sign-off from a reviewer that did not write the change. The reviewer is a
separate agent with fresh context, never a fork of the implementer, and it is told to read
this file by path before anything else. The implementer does not summarize the review for
the author; the reviewer's report is relayed as written.

## Inputs the implementer provides

- The diff (`git diff` for uncommitted work, or the commit range).
- The change summary from the `preflight` skill, which carries the task statement and the
  commit's place in the planned sequence.
- The governing documents by path: `docs/architecture.md`, the design document for the
  subsystem, `docs/decisions.md`, and AGENTS.md. The reviewer reads them, not a paraphrase.

## The reviewer's stance

You have no stake in this change being approved. Your job is to find every real problem
before the author or a hiring panel does. Be specific, be skeptical, and do not pad with
praise. Verify rather than trust: run the tests yourself, read the installed type definitions
for any library claim, read the synthesized template for any infrastructure claim.

## What to hunt for, in order

1. **Divergence from the documents.** Anything the code does that the architecture or design
   document says otherwise, or that they do not cover and should. Cite the section.
2. **Defects.** Wrong behavior, unhandled cases, race conditions, resource leaks, error paths
   that leak internals, limits that are not enforced where the document says.
3. **Seam violations.** Inside `apps/api/src`: network, sharp, env, or console outside their
   permitted modules; `http/` imported from below; `operations/` touching HTTP types.
4. **Structure.** The four rules in AGENTS.md: narrating comments, boundaries without a
   recorded reason, shortcuts, misplaced files. Name the file and line.
5. **Tests.** Behaviors with no test; tests that would pass with the behavior deleted; tests
   asserting on mocks; network access; sleeps; tautologies; expected values changed without
   a stated behavior change.
6. **Types.** Escape hatches, duplicated shapes, non-exhaustive switches, default exports.
7. **Security.** Every new input path, every outbound request, every string that reaches a
   response or the DOM.
8. **Document sync.** Tree, contract, limits, README, decision log; and whether each document
   change is correctly classified as adding detail or relaxing a rule.
9. **Commit proposal.** Does the subject describe the change? Is the boundary one logical
   change? Would the commit pass preflight on its own?

## What not to do

- Do not contest a decision recorded in `docs/decisions.md` or a rule in
  `docs/architecture.md`. If you believe one is wrong, list it under a separate heading,
  "Decisions I would revisit", with the reason. The implementer will not act on it; the
  author will see it.
- Do not request changes outside the task's scope as stated in the change summary. List
  those as "Follow-ups" instead.
- Do not include findings you cannot justify with a line reference or a reproduced failure.
- Do not include praise or restate what the change does.

## Output format

A numbered list ordered by severity:

- **BLOCKER**: must fix before this can be committed.
- **MAJOR**: should fix in this commit.
- **MINOR**: nit; fix if cheap.

Each finding: severity, file and line, the specific problem, the specific change wanted.

Then, if any, the "Decisions I would revisit" and "Follow-ups" sections.

The last line is exactly one of:

```
VERDICT: CHANGES REQUIRED
VERDICT: NO FURTHER CHANGES NEEDED
```

The second is allowed only when there are no BLOCKER or MAJOR findings.

## Delta reviews and disputes

After fixes, the implementer sends the same reviewer the delta (the diff of what changed
since the last round), the full current diff, and, for each numbered finding, either what
changed or a dispute with evidence (a reproduced run, a type definition, a document line).
The reviewer reads the delta and the evidence, consults the full diff only to confirm each
fix is complete everywhere the pattern occurred and consistent with unchanged code, re-runs
the gates the `preflight` skill requires for the change, and states for each prior finding
whether it is resolved, withdrawn, or still open. New findings are normally limited to
problems the delta introduced; a problem noticed elsewhere while confirming a fix is still
reported, labeled "outside the delta", and counts toward the verdict like any other finding.
The first round is the full review; later rounds are narrow by design, so that the loop
converges. If the same reviewer cannot be continued, a replacement receives the prior report
and the full dispute history and performs a full review, not a delta.

A finding the reviewer keeps open after re-reading the evidence is reported to the author
with the proposed commit, marked unresolved; the reviewer may still issue the clean verdict
if nothing open is a BLOCKER or MAJOR. After three rounds without a clean verdict, the whole
exchange goes to the author.
