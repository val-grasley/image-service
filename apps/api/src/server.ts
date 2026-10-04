import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { serve, type HttpBindings } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { z } from 'zod';
import { createApp, defaultDeps } from './app.ts';
import { loadConfig } from './config.ts';

// The manifest sits outside the build's rootDir, so it is read rather than imported; this entry
// always runs from src/ or dist/, one level below it.
const { version } = z
  .object({ version: z.string() })
  .parse(createRequire(import.meta.url)('../package.json'));
const config = loadConfig();
const deps = defaultDeps(config, version);
const app = createApp(config, deps, version);
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));

function withUi(root: string): Hono<{ Bindings: HttpBindings }> {
  const site = new Hono<{ Bindings: HttpBindings }>();
  const ui = serveStatic<{ Bindings: HttpBindings }>({
    root,
    onFound: (_path, c) => {
      c.header('Cache-Control', 'no-cache');
    },
  });
  // The paths CloudFront routes to the UI bucket in production; a missing file falls through
  // to the API, which answers 404.
  for (const path of ['/', '/index.html', '/favicon.ico', '/assets/*']) {
    site.get(path, ui);
  }
  site.all('*', (c) => app.fetch(c.req.raw, c.env));
  return site;
}

const server = existsSync(webDist) ? withUi(webDist) : app;
serve({ fetch: server.fetch, port: config.port }, (info) => {
  deps.logger.info('listening', { port: info.port, ui: existsSync(webDist) });
});
