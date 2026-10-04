import { z, type OpenAPIHono, type RouteConfig } from '@hono/zod-openapi';
import type { ErrorCode } from '@image-service/sdk';
import type { AppEnv } from './context.ts';
import { ERROR_CODES, STATUS } from './errors.ts';

export const DOCUMENTATION_CACHE_CONTROL = 'public, max-age=3600';

const problemDetails = z
  .object({
    type: z
      .string()
      .openapi({ description: 'Relative link to the section of /docs describing the code.' }),
    title: z.string(),
    status: z.number().int(),
    detail: z.string(),
    code: z.enum(ERROR_CODES),
    requestId: z.string(),
    errors: z
      .array(z.object({ field: z.string(), message: z.string() }))
      .optional()
      .openapi({
        description: 'On invalid_parameter: one entry per rejected query parameter.',
      }),
    upstreamStatus: z.number().int().optional().openapi({
      description: 'On upstream_error, when the source answered with a non-2xx status.',
    }),
  })
  .openapi('ProblemDetails');

export type ProblemDetailsBody = z.output<typeof problemDetails>;

// ProblemDetails narrowed to the codes a response can carry.
function problemContent(codes: readonly ErrorCode[]) {
  return {
    'application/problem+json': {
      schema: {
        allOf: [
          { $ref: '#/components/schemas/ProblemDetails' },
          {
            type: 'object' as const,
            properties: { code: { type: 'string' as const, enum: [...codes] } },
          },
        ],
      },
    },
  };
}

// A route's responses are keyed by status, so codes sharing one status on a route are listed
// together in a single response; a code alone at its status refers to its own component.
export function problemResponses(codes: readonly ErrorCode[]): RouteConfig['responses'] {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of codes) {
    const { status } = STATUS[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  const responses: RouteConfig['responses'] = {};
  for (const [status, sharing] of byStatus) {
    const [only, ...others] = sharing;
    if (only !== undefined && others.length === 0) {
      responses[status] = { $ref: `#/components/responses/${only}` };
    } else {
      const titles = sharing.map((code) => `${STATUS[code].title} (${code})`).join(' or ');
      responses[status] = { description: `${titles}.`, content: problemContent(sharing) };
    }
  }
  return responses;
}

export function addOpenApiDocument(app: OpenAPIHono<AppEnv>, version: string): void {
  app.openAPIRegistry.register('ProblemDetails', problemDetails);
  for (const code of ERROR_CODES) {
    app.openAPIRegistry.registerComponent('responses', code, {
      description: `${STATUS[code].title}. See /docs#error-${code}.`,
      content: problemContent([code]),
    });
  }
  app.use('/openapi.json', async (c, next) => {
    await next();
    if (c.res.status === 200) {
      c.header('Cache-Control', DOCUMENTATION_CACHE_CONTROL);
    }
  });
  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'Image processing service', version },
    servers: [],
  });
}
