import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../context.ts';

const health = z.object({ status: z.literal('ok'), version: z.string() });

export function addHealthRoute(app: OpenAPIHono<AppEnv>, version: string): void {
  const route = createRoute({
    method: 'get',
    path: '/health',
    summary: 'Report that the service can answer',
    responses: {
      200: {
        description: 'The service is running.',
        content: { 'application/json': { schema: health } },
      },
    },
  });

  app.openapi(route, (c) =>
    c.json({ status: 'ok', version }, 200, { 'Cache-Control': 'no-store' }),
  );
}
