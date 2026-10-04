---
name: image-pipeline
description: "Use when changing apps/api/src/image/ (the transform spec or the sharp pipeline), adding a transformation or output format, or writing tests that need image fixtures."
paths:
  - apps/api/src/image/**
---

# Image pipeline

The contract is `docs/architecture.md` section 7. The operation order, the crop-mode
mapping, the encoder options, the error mapping, and the test plan are
`docs/design/image-pipeline.md`; read its "pipeline.ts" section before touching the
pipeline. `pipeline.ts` is the only module in `apps/api/src` that imports sharp; test files
may import it to read metadata back.

## Rules this skill adds

- A reorder of the operation sequence, a changed encoder option, or a changed crop
  semantics bumps `PIPELINE_REVISION` and updates the design document in the same commit.
- The crop-mode table is one function with one test per row on a non-square source. sharp's
  `fit: 'fill'` is our `scale`; our `fill` is sharp's `cover`. Getting this wrong is
  silent.
- Never assert an absolute byte length of a lossy encode; relative comparisons and cap
  tests with a generous bound are fine.

## Fixtures

Every fixture comes from `generateImage` in `packages/fake-upstream`
(`docs/design/fake-upstream.md`, "Generator"). Read dimensions back with
`sharp(buffer).metadata()`.

## Verify before use

Check every sharp option against the installed sharp type definitions (the `types` entry
in its `package.json`): `withoutEnlargement`, `limitInputPixels`, `timeout({ seconds })`,
`avif({ effort })`, `autoOrient`. The error message texts the pipeline matches on are in
the design document's "Errors" section.
