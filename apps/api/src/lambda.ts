import { streamHandle } from '@hono/aws-lambda';
import { createApp, defaultDeps } from './app.ts';
import { loadConfig } from './config.ts';

// No manifest is reachable from the bundle, so the CDK bundling's esbuild `define` supplies the
// version from apps/api/package.json (decision 44).
declare const SERVICE_VERSION: string;

const config = loadConfig();
// The adapter's package does not export its Handler type by name.
export const handler: ReturnType<typeof streamHandle> = streamHandle(
  createApp(config, defaultDeps(config, SERVICE_VERSION), SERVICE_VERSION),
);
