import { startFakeUpstream } from '@image-service/fake-upstream/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ERROR_CODES } from '../src/http/errors.ts';
import { createHarness, type FakeUpstream } from './harness.ts';

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
