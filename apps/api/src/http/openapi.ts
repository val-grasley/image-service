import { z, type OpenAPIHono, type RouteConfig } from '@hono/zod-openapi';
import type { ErrorCode } from '@image-service/sdk';
import { WINDOW_MS } from '../rate-limit/limiter.ts';
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

type Header = {
  description: string;
  required: boolean;
  schema: { type: 'string' | 'integer'; enum?: string[]; const?: string };
};

export function header(
  description: string,
  schema: Header['schema'] = { type: 'string' },
  required = true,
): Header {
  return { description, required, schema };
}

// Set on every response by the request-id and cors middleware; the route supplies its own
// Cache-Control value.
export function commonHeaders(cacheControl: string): Record<string, Header> {
  return {
    'Cache-Control': header('How long caches may keep this response.', {
      type: 'string',
      const: cacheControl,
    }),
    'X-Request-Id': header(
      "Identifies this request: the caller's X-Request-Id if it matches [A-Za-z0-9._-]{1,64}, else a generated one.",
    ),
    'Access-Control-Allow-Origin': header('Any origin may read the response.', {
      type: 'string',
      const: '*',
    }),
    'Access-Control-Expose-Headers': header(
      'The response headers a browser script may read: ETag, X-Request-Id, the X-Image-* headers, X-Result-Cache, and the rate-limit headers.',
    ),
  };
}

function problemHeaders(codes: readonly ErrorCode[]): Record<string, Header> {
  const window = String(WINDOW_MS / 1000);
  return {
    ...commonHeaders('no-store'),
    ...(codes.includes('rate_limited') && {
      'Retry-After': header('Seconds until the rate-limit window ends.', { type: 'integer' }),
      RateLimit: header(
        '"default";r=<remaining>;t=<seconds until reset>, per draft-ietf-httpapi-ratelimit-headers.',
      ),
      'RateLimit-Policy': header(
        `"default";q=<requests per window>;w=${window}, per draft-ietf-httpapi-ratelimit-headers.`,
      ),
    }),
    ...(codes.includes('method_not_allowed') && {
      Allow: header('The methods this path accepts.'),
    }),
  };
}

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
      responses[status] = {
        description: `${titles}.`,
        headers: problemHeaders(sharing),
        content: problemContent(sharing),
      };
    }
  }
  return responses;
}

export function addOpenApiDocument(app: OpenAPIHono<AppEnv>, version: string): void {
  app.openAPIRegistry.register('ProblemDetails', problemDetails);
  for (const code of ERROR_CODES) {
    app.openAPIRegistry.registerComponent('responses', code, {
      description: `${STATUS[code].title}. See /docs#error-${code}.`,
      headers: problemHeaders([code]),
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
