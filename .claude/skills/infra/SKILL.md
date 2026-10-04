---
name: infra
description: "Use when working in infra/ (the CDK stack), changing Lambda configuration or environment variables, or changing anything about CloudFront behaviors, origin request policies, or S3 deployment."
paths:
  - infra/**
  - apps/api/src/lambda.ts
---

# Infrastructure

The deployment shape is `docs/architecture.md` section 2. The resources, the CloudFront
policies, the function environment, the bundling recipe, and the template test are
`docs/design/infrastructure.md`. Every load-bearing setting in its "Resources" and
"CloudFront" sections is asserted by the test in its "Tests" section, so a change to one
fails a test until the test and the document change with it.

## Rules this skill adds

- `npm run synth` runs with no credentials and bundling skipped; run it and the template
  test before proposing any commit that touches `infra/`.
- Do not use `nodeModules: ['sharp']`; the design document's "Bundling" section says why
  and gives the recipe. Read the hook names against the installed `aws-cdk-lib` types
  before changing them.
- A deploy whose function fails at runtime with sharp's message
  `Could not load the "sharp" module using the <platform> runtime` means the platform
  install hook did not run; check that before anything else.
- The entry uses `streamHandle` from `@hono/aws-lambda`, not the deprecated adapter inside
  `hono`.
- Grants through L2 `grant*` methods; no hand-written IAM except the invalidation
  resource's single action. No secrets, account IDs, or regions in code.
