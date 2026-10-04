# Design: infrastructure

Implements `docs/architecture.md` section 2 and the Lambda settings in section 8. Directory:
`infra/`, a CDK application in TypeScript. One stack, `ImageServiceStack`, in
`lib/image-service-stack.ts`. It is split into constructs only if a reader would name a
resource group as a step (the function and its URL, the distribution and its policies, the
table), never because of length.

## Resources

| Resource | Settings |
|---|---|
| S3 bucket `ui` | Private, block public access, `removalPolicy: DESTROY`, `autoDeleteObjects: true` |
| `BucketDeployment` | Source from the stack's `uiSourcePath` prop (default `apps/web/dist`); `distribution` and `distributionPaths: ['/index.html', '/favicon.ico', '/assets/*']` so a UI change invalidates the UI paths only |
| `NodejsFunction` `api` | Entry `apps/api/src/lambda.ts`, handler `handler`, `NODEJS_24_X`, `ARM_64`, 1536 MB, 20 s, `reservedConcurrentExecutions: 10`, environment below |
| Function URL | `authType: AWS_IAM`, `invokeMode: RESPONSE_STREAM` |
| DynamoDB table `rateLimit` | Partition key `pk` (string), on-demand, `timeToLiveAttribute: 'expiresAt'`, `removalPolicy: DESTROY`; `grantWriteData` to the function |
| CloudFront distribution | Two origins, behaviors, policies below; default root object `index.html`; HTTP/2 and 3; TLS 1.2 minimum |
| Invalidation on API change | `AwsCustomResource` calling `cloudfront:CreateInvalidation` for `/docs*` and `/openapi.json`, with `CallerReference` and `physicalResourceId` both set from the function's current version string so it runs once per new function version, and a policy granting `cloudfront:CreateInvalidation` on the distribution |
| Outputs | Distribution domain, Function URL |

### CloudFront

- Origin `ui`: the bucket with origin access control.
- Origin `api`: `FunctionUrlOrigin.withOriginAccessControl(functionUrl)`.
- Behaviors: `/index.html`, `/favicon.ico`, `/assets/*` → `ui`, cache policy
  `CACHING_OPTIMIZED`. Default behavior → `api`. The default root object serves `/`.
- API cache policy: query strings `all`, headers `none`, cookies `none`, default TTL 0,
  min TTL 0, max TTL 86400, so origin `Cache-Control` governs and a missing header means no
  caching. Gzip and Brotli disabled (images are already compressed).
- API origin request policy: headers allow-list exactly `CloudFront-Viewer-Address`,
  `X-Image-Service-Fetch`, `X-Request-Id`; query strings `all`; cookies `none`.
- Response headers policy: none; the service sets its own.
- No WAF, no custom domain, no logging bucket.

### Function environment

The variables set explicitly in production:

```
RATE_LIMIT_BACKEND=dynamodb
RATE_LIMIT_TABLE=<table name>
CLIENT_IP_SOURCE=cloudfront
```

`PUBLIC_HOSTS` is not set (decision 26). Everything else uses its default.

## Bundling

`NodejsFunction` bundles with the locally installed esbuild (`forceDockerBundling: false`).
sharp is excluded from the bundle and installed for the target platform in the asset:

```ts
bundling: {
  format: OutputFormat.ESM,
  target: 'node24',
  externalModules: ['sharp'],
  commandHooks: {
    beforeBundling: () => [],
    beforeInstall: () => [],
    afterBundling: (_input, output) => [
      `npm install --prefix ${output} --os=linux --cpu=arm64 --libc=glibc --no-save --no-package-lock --no-audit --no-fund sharp@${sharpVersion}`,
    ],
  },
}
```

`sharpVersion` is read from `apps/api/package.json` at synth so the asset carries the pinned
version. `nodeModules: ['sharp']` is not used because it runs `npm ci` against a copy of the
root lockfile in a directory with a generated manifest, which fails in a workspaces
repository.

The install needs network, so bundling is skipped for the template check:
`npm run synth` runs `cdk synth --context aws:cdk:bundling-stacks='[]'`, which synthesizes
with asset placeholders. `cdk deploy` bundles for real.

## Lambda entry

`apps/api/src/lambda.ts`:

```ts
export const handler = streamHandle(createApp(config, defaultDeps(config)));
```

`streamHandle` from the `@hono/aws-lambda` package (the adapter inside `hono` itself is
deprecated for removal in Hono 5) wraps the app in `awslambda.streamifyResponse`, which the
Node 24 managed runtime provides. The config and deps are built once per execution
environment at module load.

## Deploy steps (README)

```
npm ci
npm run build                 # SDK, UI, API typecheck
npx cdk bootstrap             # once per account and region
npm run deploy                # cdk deploy, prints the outputs
```

Credentials come from the ambient AWS environment; nothing is read from the repository.
Region and account come from `CDK_DEFAULT_REGION` and `CDK_DEFAULT_ACCOUNT`.

## Tests

`infra/lib/image-service-stack.test.ts` uses `Template.fromStack` on a stack synthesized
with bundling skipped and `uiSourcePath` pointing at an empty temporary directory, so the
test needs no UI build, and asserts:

- The origin request policy's header allow-list is exactly the three names.
- The API cache policy forwards all query strings and no headers or cookies.
- Behaviors: the three UI path patterns target the S3 origin; the default targets the
  function URL origin.
- The function URL has `AuthType: AWS_IAM` and `InvokeMode: RESPONSE_STREAM`.
- The function has the memory, timeout, architecture, runtime, and reserved concurrency
  from section 8, and exactly the three environment variables above.
- The table has `pk` as its key and `expiresAt` as its TTL attribute.
- The invalidation custom resource lists `/docs*` and `/openapi.json`.

A change to any load-bearing setting therefore fails a test before it reaches a deploy.
