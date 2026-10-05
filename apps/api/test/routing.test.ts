import { startFakeUpstream } from '@image-service/fake-upstream/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ERROR_CODES } from '../src/http/errors.ts';
import { createHarness, query, sourceUrl, type FakeUpstream } from './harness.ts';

let fake: FakeUpstream;

beforeAll(async () => {
  fake = await startFakeUpstream();
});

afterAll(async () => {
  await fake.close();
});

describe('routing', () => {
  it('answers an unknown path with a 404 problem', async () => {
    const response = await createHarness(fake).request('/nothing-here');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(await response.json()).toMatchObject({
      type: '/docs#error-not_found',
      code: 'not_found',
      status: 404,
    });
  });

  for (const { method, path } of [
    { method: 'POST', path: '/process' },
    { method: 'PUT', path: '/info' },
    { method: 'DELETE', path: '/health' },
  ]) {
    it(`answers ${method} ${path} with a 405 problem listing GET and HEAD in Allow`, async () => {
      const response = await createHarness(fake).request(path, { method });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, HEAD');
      expect(await response.json()).toMatchObject({ code: 'method_not_allowed', status: 405 });
    });
  }

  it('reports health with the service version and no-store', async () => {
    const { request, serviceVersion: version } = createHarness(fake);
    const response = await request('/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'ok', version });
  });

  it('answers HEAD /health with no body', async () => {
    const response = await createHarness(fake).request('/health', { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });
});

const problemResponse = z.object({
  content: z.object({
    'application/problem+json': z.object({
      schema: z.object({
        allOf: z.tuple([
          z.object({ $ref: z.literal('#/components/schemas/ProblemDetails') }),
          z.object({ properties: z.object({ code: z.object({ enum: z.array(z.string()) }) }) }),
        ]),
      }),
    }),
  }),
});
const response = z.union([z.object({ $ref: z.string() }), problemResponse]);
const operation = z.object({
  parameters: z.array(z.object({ name: z.string() })).default([]),
  responses: z.record(z.string(), z.union([response, z.object({ description: z.string() })])),
});
const openApiDocument = z.object({
  openapi: z.string(),
  info: z.object({ version: z.string() }),
  paths: z.record(z.string(), z.object({ get: operation })),
  components: z.object({ responses: z.record(z.string(), problemResponse) }),
});
type OpenApiDocument = z.output<typeof openApiDocument>;

// The codes a route's error responses admit, read from each response's code enum and
// following references into the response components.
function codesListed(doc: OpenApiDocument, path: string): string[] {
  const responses = Object.values(doc.paths[path]?.get.responses ?? {});
  return responses
    .flatMap((entry) => {
      const resolved =
        '$ref' in entry
          ? doc.components.responses[entry.$ref.replace('#/components/responses/', '')]
          : entry;
      const parsed = problemResponse.safeParse(resolved);
      return parsed.success
        ? parsed.data.content['application/problem+json'].schema.allOf[1].properties.code.enum
        : [];
    })
    .sort();
}

describe('/openapi.json', () => {
  async function document() {
    const response = await createHarness(fake).request('/openapi.json');
    expect(response.status).toBe(200);
    return openApiDocument.parse(await response.json());
  }

  it('is OpenAPI 3.1 at the service version and lists exactly the three paths', async () => {
    const doc = await document();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toBe(createHarness(fake).serviceVersion);
    expect(Object.keys(doc.paths).sort()).toEqual(['/health', '/info', '/process']);
  });

  it('lists every query parameter of /process and /info', async () => {
    const { paths } = await document();
    const names = (path: string) => paths[path]?.get.parameters.map(({ name }) => name);
    expect(names('/process')).toEqual(['url', 'width', 'height', 'crop', 'format', 'quality']);
    expect(names('/info')).toEqual(['url']);
    expect(names('/health')).toEqual([]);
  });

  it('has a response component for every error code', async () => {
    const { components } = await document();
    expect(Object.keys(components.responses).sort()).toEqual([...ERROR_CODES].sort());
  });

  it('lists on each route exactly the error codes it can produce', async () => {
    const doc = await document();
    const listed = (path: string) => codesListed(doc, path);
    expect(listed('/process')).toEqual(
      [
        'invalid_parameter',
        'url_not_allowed',
        'source_too_large',
        'unsupported_source_type',
        'output_too_large',
        'rate_limited',
        'internal_error',
        'transform_timeout',
        'upstream_error',
        'too_many_redirects',
        'upstream_timeout',
      ].sort(),
    );
    expect(listed('/info')).toEqual(
      [
        'invalid_parameter',
        'url_not_allowed',
        'source_too_large',
        'unsupported_source_type',
        'rate_limited',
        'internal_error',
        'upstream_error',
        'too_many_redirects',
        'upstream_timeout',
      ].sort(),
    );
    expect(listed('/health')).toEqual(['internal_error', 'url_not_allowed']);
  });
});

const documentedHeaders = z.object({
  headers: z
    .record(
      z.string(),
      z.object({
        description: z.string().min(1),
        schema: z.object({ const: z.string().optional(), enum: z.array(z.string()).optional() }),
      }),
    )
    .default({}),
});
const headersDocument = z.object({
  paths: z.record(
    z.string(),
    z.object({
      get: z.object({
        responses: z.record(
          z.string(),
          z.union([z.object({ $ref: z.string() }), documentedHeaders]),
        ),
      }),
    }),
  ),
  components: z.object({ responses: z.record(z.string(), documentedHeaders) }),
});
type HeadersDocument = z.output<typeof headersDocument>;
type Documented = { path: string; status: string } | { component: string };

function documentedHeaderObjects(doc: HeadersDocument, where: Documented) {
  const entry =
    'component' in where
      ? doc.components.responses[where.component]
      : doc.paths[where.path]?.get.responses[where.status];
  const resolved =
    entry !== undefined && '$ref' in entry
      ? doc.components.responses[entry.$ref.replace('#/components/responses/', '')]
      : entry;
  return resolved?.headers ?? {};
}

function headersDocumented(doc: HeadersDocument, where: Documented): string[] {
  return Object.keys(documentedHeaderObjects(doc, where))
    .map((name) => name.toLowerCase())
    .sort();
}

// OpenAPI ignores a response header named Content-Type; each response's content map
// documents it instead.
function headersSent(response: Response): string[] {
  return [...response.headers.keys()].filter((name) => name !== 'content-type').sort();
}

const COMMON = [
  'access-control-allow-origin',
  'access-control-expose-headers',
  'cache-control',
  'x-request-id',
];
const IMAGE = [
  ...COMMON,
  'content-disposition',
  'content-length',
  'etag',
  'x-content-type-options',
  'x-image-format',
  'x-image-height',
  'x-image-width',
  'x-result-cache',
];
const RATE_LIMITED = [...COMMON, 'ratelimit', 'ratelimit-policy', 'retry-after'];

describe('/openapi.json response headers', () => {
  async function document() {
    const response = await createHarness(fake).request('/openapi.json');
    return headersDocument.parse(await response.json());
  }

  const cases: {
    name: string;
    where: Documented;
    expected: string[];
    send: () => Promise<Response>;
  }[] = [
    {
      name: 'an image from /process',
      where: { path: '/process', status: '200' },
      expected: IMAGE,
      send: () =>
        createHarness(fake).request(
          query('/process', { url: sourceUrl(fake, '/image/png'), width: '10' }),
        ),
    },
    {
      name: 'a 304 from /process',
      where: { path: '/process', status: '304' },
      expected: [...COMMON, 'etag'],
      send: async () => {
        const { request } = createHarness(fake);
        const path = query('/process', { url: sourceUrl(fake, '/image/png'), width: '10' });
        const etag = (await request(path)).headers.get('etag') ?? '';
        return request(path, { headers: { 'If-None-Match': etag } });
      },
    },
    {
      name: 'an invalid_parameter problem from /process',
      where: { path: '/process', status: '400' },
      expected: COMMON,
      send: () => createHarness(fake).request(query('/process', { url: 'not a url' })),
    },
    {
      name: 'a 502 problem from /process, whose response two codes share',
      where: { path: '/process', status: '502' },
      expected: COMMON,
      send: () =>
        createHarness(fake).request(query('/process', { url: sourceUrl(fake, '/status/404') })),
    },
    {
      name: 'metadata from /info',
      where: { path: '/info', status: '200' },
      expected: COMMON,
      send: () =>
        createHarness(fake).request(query('/info', { url: sourceUrl(fake, '/image/png') })),
    },
    {
      name: 'a rate_limited problem from /info',
      where: { path: '/info', status: '429' },
      expected: RATE_LIMITED,
      send: async () => {
        const { request } = createHarness(fake, { config: { rateLimitPerMinute: 1 } });
        const path = query('/info', { url: sourceUrl(fake, '/image/png') });
        await request(path);
        return request(path);
      },
    },
    {
      name: 'the /health report',
      where: { path: '/health', status: '200' },
      expected: COMMON,
      send: () => createHarness(fake).request('/health'),
    },
    {
      name: 'a url_not_allowed problem from /health, for the loop marker',
      where: { path: '/health', status: '403' },
      expected: COMMON,
      send: () =>
        createHarness(fake).request('/health', { headers: { 'X-Image-Service-Fetch': '1' } }),
    },
    {
      name: 'a method_not_allowed problem',
      where: { component: 'method_not_allowed' },
      expected: [...COMMON, 'allow'],
      send: () => createHarness(fake).request('/process', { method: 'POST' }),
    },
    {
      name: 'a not_found problem',
      where: { component: 'not_found' },
      expected: COMMON,
      send: () => createHarness(fake).request('/nothing-here'),
    },
  ];

  for (const c of cases) {
    it(`documents exactly the headers sent with ${c.name}, and the values it fixes`, async () => {
      const doc = await document();
      const documented = headersDocumented(doc, c.where);
      expect(documented).toEqual([...c.expected].sort());
      const response = await c.send();
      expect(headersSent(response)).toEqual(documented);
      for (const [name, { schema }] of Object.entries(documentedHeaderObjects(doc, c.where))) {
        const value = response.headers.get(name);
        if (schema.const !== undefined) {
          expect(value, name).toBe(schema.const);
        }
        if (schema.enum !== undefined) {
          expect(schema.enum, name).toContain(value);
        }
      }
    });
  }

  it('documents on every problem response the headers each problem carries, adding the rate-limit headers on 429 and Allow on 405', async () => {
    const doc = await document();
    const problems: Documented[] = [
      ...Object.entries(doc.paths).flatMap(([path, { get }]) =>
        Object.keys(get.responses)
          .filter((status) => Number(status) >= 400)
          .map((status) => ({ path, status })),
      ),
      ...Object.keys(doc.components.responses).map((component) => ({ component })),
    ];
    const expected = (where: Documented) => {
      const code = 'component' in where ? where.component : undefined;
      if (code === 'rate_limited' || ('status' in where && where.status === '429')) {
        return RATE_LIMITED;
      }
      return code === 'method_not_allowed' ? [...COMMON, 'allow'] : COMMON;
    };
    for (const where of problems) {
      expect(headersDocumented(doc, where), JSON.stringify(where)).toEqual(
        [...expected(where)].sort(),
      );
    }
  });
});

describe('/docs', () => {
  it('has a section anchored at error-<code> for every error code, and the Swagger UI', async () => {
    const response = await createHarness(fake).request('/docs');
    const page = await response.text();
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    for (const code of ERROR_CODES) {
      expect(page).toContain(`<section id="error-${code}">`);
    }
    expect(page).toContain("url: '/openapi.json'");
  });
});
