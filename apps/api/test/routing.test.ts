import { startFakeUpstream } from '@image-service/fake-upstream/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
