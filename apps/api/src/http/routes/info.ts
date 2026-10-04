import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Config } from '../../config.ts';
import type { OperationDeps } from '../../operations/deps.ts';
import { describeSource } from '../../operations/describe-source.ts';
import type { AppEnv } from '../context.ts';
import { sourceUrlParam } from './process.ts';

const sourceInfo = z
  .object({
    url: z.string().openapi({ description: 'The URL as requested.' }),
    finalUrl: z.string().openapi({ description: 'The URL after redirects.' }),
    format: z.enum(['jpeg', 'png', 'webp', 'gif', 'avif', 'tiff']).openapi({
      description: 'The type detected from the bytes.',
    }),
    width: z.number().int().openapi({ description: 'Width in pixels after EXIF orientation.' }),
    height: z.number().int().openapi({ description: 'Height in pixels after EXIF orientation.' }),
    bytes: z.number().int().openapi({ description: 'Size of the source in bytes.' }),
    pages: z.number().int().openapi({ description: 'Frame or page count.' }),
  })
  .openapi('SourceInfo');

export type InfoResponse = z.output<typeof sourceInfo>;

export function addInfoRoute(app: OpenAPIHono<AppEnv>, config: Config, deps: OperationDeps): void {
  const route = createRoute({
    method: 'get',
    path: '/info',
    summary: 'Read the metadata of a source image without transforming it',
    request: { query: z.object({ url: sourceUrlParam }) },
    responses: {
      200: {
        description: 'Metadata of the source image.',
        content: { 'application/json': { schema: sourceInfo } },
      },
    },
  });
  const cacheControl = `public, max-age=${String(config.sourceCacheTtlSeconds)}`;

  app.openapi(route, async (c) => {
    const url = new URL(c.req.valid('query').url);
    c.set('sourceHostname', url.hostname);
    const info = await describeSource(url, deps, c.var.log);
    return c.json(info, 200, { 'Cache-Control': cacheControl });
  });
}
