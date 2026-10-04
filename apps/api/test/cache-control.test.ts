import { startFakeUpstream } from '@image-service/fake-upstream/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, query, sourceUrl, type FakeUpstream } from './harness.ts';
import { testConfig } from './test-config.ts';

let fake: FakeUpstream;

beforeAll(async () => {
  fake = await startFakeUpstream();
});

afterAll(async () => {
  await fake.close();
});

const config = testConfig();
const RESULT = `public, max-age=${String(config.resultCacheTtlSeconds)}`;
const SOURCE = `public, max-age=${String(config.sourceCacheTtlSeconds)}`;

describe('Cache-Control', () => {
  const image = () => query('/process', { url: sourceUrl(fake, '/image/png'), width: '8' });
  const cases: {
    name: string;
    path: () => string;
    init?: RequestInit;
    status: number;
    expected: string;
  }[] = [
    { name: 'GET /process', path: image, status: 200, expected: RESULT },
    { name: 'HEAD /process', path: image, init: { method: 'HEAD' }, status: 200, expected: RESULT },
    {
      name: 'GET /info',
      path: () => query('/info', { url: sourceUrl(fake, '/image/png') }),
      status: 200,
      expected: SOURCE,
    },
    { name: 'GET /health', path: () => '/health', status: 200, expected: 'no-store' },
    { name: 'a 400', path: () => '/process?width=0', status: 400, expected: 'no-store' },
    {
      name: 'a 403',
      path: () => query('/info', { url: 'http://localhost/' }),
      status: 403,
      expected: 'no-store',
    },
    {
      name: 'a 415',
      path: () => query('/process', { url: sourceUrl(fake, '/html') }),
      status: 415,
      expected: 'no-store',
    },
    {
      name: 'a 502',
      path: () => query('/info', { url: sourceUrl(fake, '/status/500') }),
      status: 502,
      expected: 'no-store',
    },
    { name: 'an unknown path', path: () => '/nothing-here', status: 404, expected: 'no-store' },
    {
      name: 'a wrong method',
      path: () => '/process',
      init: { method: 'POST' },
      status: 405,
      expected: 'no-store',
    },
  ];

  for (const c of cases) {
    it(`is ${c.expected} on ${c.name}`, async () => {
      const response = await createHarness(fake).request(c.path(), c.init);
      expect([response.status, response.headers.get('cache-control')]).toEqual([
        c.status,
        c.expected,
      ]);
    });
  }

  it(`is ${RESULT} on a 304`, async () => {
    const harness = createHarness(fake);
    const etag = (await harness.request(image())).headers.get('etag') ?? '';
    const response = await harness.request(image(), { headers: { 'If-None-Match': etag } });
    expect([response.status, response.headers.get('cache-control')]).toEqual([304, RESULT]);
  });

  it('is no-store on a 429', async () => {
    const harness = createHarness(fake, { config: { rateLimitPerMinute: 1 } });
    await harness.request('/process');
    const response = await harness.request('/process');
    expect([response.status, response.headers.get('cache-control')]).toEqual([429, 'no-store']);
  });

  it('is no-store on a CORS preflight, which no route answers', async () => {
    const response = await createHarness(fake).request('/process', {
      method: 'OPTIONS',
      headers: { Origin: 'https://ui.example', 'Access-Control-Request-Method': 'GET' },
    });
    expect([response.status, response.headers.get('cache-control')]).toEqual([204, 'no-store']);
  });
});
