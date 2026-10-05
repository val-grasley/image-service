import { startFakeUpstream } from '@image-service/fake-upstream/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, query, sourceUrl, type FakeUpstream } from './harness.ts';

let fake: FakeUpstream;

beforeAll(async () => {
  fake = await startFakeUpstream();
});

afterAll(async () => {
  await fake.close();
});

const EXPOSED = [
  'ETag',
  'X-Request-Id',
  'X-Image-Width',
  'X-Image-Height',
  'X-Image-Format',
  'X-Result-Cache',
  'Retry-After',
  'RateLimit',
  'RateLimit-Policy',
];
const RATE_LIMIT_HEADERS = ['retry-after', 'ratelimit', 'ratelimit-policy'];

describe('request-id', () => {
  it('echoes a valid X-Request-Id', async () => {
    const response = await createHarness(fake).request('/health', {
      headers: { 'X-Request-Id': 'Abc.123_x-y' },
    });
    expect(response.headers.get('x-request-id')).toBe('Abc.123_x-y');
  });

  for (const { name, offered } of [
    { name: 'one with a space', offered: 'not valid' },
    { name: 'one longer than 64 characters', offered: 'a'.repeat(65) },
    { name: 'an empty one', offered: '' },
  ]) {
    it(`replaces ${name} with a generated id`, async () => {
      const response = await createHarness(fake).request('/health', {
        headers: { 'X-Request-Id': offered },
      });
      const id = response.headers.get('x-request-id');
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(id).not.toBe(offered);
    });
  }

  it('puts the same id in the problem body and the header of an error', async () => {
    const response = await createHarness(fake).request('/nothing-here', {
      headers: { 'X-Request-Id': 'error-id' },
    });
    expect(response.headers.get('x-request-id')).toBe('error-id');
    expect(await response.json()).toMatchObject({ requestId: 'error-id' });
  });

  it('writes one request line with the documented fields and no query string', async () => {
    const harness = createHarness(fake);
    await harness.request(
      query('/process', { url: sourceUrl(fake, '/image/png?w=8'), width: '4' }),
      {
        headers: { 'X-Request-Id': 'logged' },
      },
    );
    const requestLines = harness.logs().filter((line) => line.msg === 'request');
    expect(requestLines).toHaveLength(1);
    const { time, durationMs, ...fields } = requestLines[0] ?? {};
    expect([typeof time, typeof durationMs]).toEqual(['string', 'number']);
    expect(fields).toEqual({
      level: 'info',
      msg: 'request',
      requestId: 'logged',
      method: 'GET',
      path: '/process',
      status: 200,
      resultCache: 'miss',
      hostname: '127.0.0.1',
    });
    expect(JSON.stringify(harness.logs())).not.toContain('w=8');
  });
});

describe('loop guard', () => {
  it('refuses a request carrying the fetch marker without fetching', async () => {
    const before = fake.requests().length;
    const response = await createHarness(fake).request(
      query('/process', { url: sourceUrl(fake, '/image/png') }),
      { headers: { 'X-Image-Service-Fetch': '1' } },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'url_not_allowed' });
    expect(fake.requests()).toHaveLength(before);
  });
});

describe('CORS', () => {
  function corsHeaders(response: Response) {
    return {
      origin: response.headers.get('access-control-allow-origin'),
      exposed: response.headers.get('access-control-expose-headers')?.split(','),
    };
  }
  function preflightHeaders(response: Response) {
    return {
      status: response.status,
      origin: response.headers.get('access-control-allow-origin'),
      methods: response.headers.get('access-control-allow-methods'),
      headers: response.headers.get('access-control-allow-headers'),
      maxAge: response.headers.get('access-control-max-age'),
    };
  }
  const PREFLIGHT_ANSWER = {
    status: 204,
    origin: '*',
    methods: 'GET,HEAD',
    headers: 'If-None-Match,X-Request-Id',
    maxAge: '600',
  };

  it('allows any origin and exposes exactly the documented headers on 200, 304, and errors', async () => {
    const harness = createHarness(fake);
    const path = query('/process', { url: sourceUrl(fake, '/image/png'), width: '8' });
    const ok = await harness.request(path);
    const notModified = await harness.request(path, {
      headers: { 'If-None-Match': ok.headers.get('etag') ?? '' },
    });
    const error = await harness.request('/process?width=0');
    expect(notModified.status).toBe(304);
    expect(error.status).toBe(400);
    for (const response of [ok, notModified, error]) {
      expect(corsHeaders(response)).toEqual({ origin: '*', exposed: EXPOSED });
    }
  });

  for (const { name, headers } of [
    {
      name: 'with its CORS request headers,',
      headers: {
        Origin: 'https://client.example',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'if-none-match',
      },
    },
    { name: 'stripped of its CORS request headers, as CloudFront forwards it,', headers: {} },
  ]) {
    it(`answers a preflight ${name} with 204, allowing both request headers the API reads`, async () => {
      const response = await createHarness(fake).request('/process', {
        method: 'OPTIONS',
        headers,
      });
      expect(preflightHeaders(response)).toEqual(PREFLIGHT_ANSWER);
    });
  }

  it('answers a preflight from a client whose rate-limit budget is spent', async () => {
    const { request } = createHarness(fake, { config: { rateLimitPerMinute: 1 } });
    await request('/process');
    const preflight = await request('/process', { method: 'OPTIONS' });
    const refused = await request('/process');
    expect(preflightHeaders(preflight)).toEqual(PREFLIGHT_ANSWER);
    expect(refused.status).toBe(429);
  });

  it('sends a max-age of 0 when CORS_MAX_AGE_SECONDS is 0, so a browser does not reuse the answer', async () => {
    const response = await createHarness(fake, { config: { corsMaxAgeSeconds: 0 } }).request(
      '/process',
      { method: 'OPTIONS' },
    );
    expect(preflightHeaders(response)).toEqual({ ...PREFLIGHT_ANSWER, maxAge: '0' });
  });
});

describe('rate limit', () => {
  const limited = { rateLimitPerMinute: 2, clientIpSource: 'x-forwarded-for' } as const;
  const from = (address: string) => ({ headers: { 'X-Forwarded-For': address } });

  it('counts invalid requests and refuses past the limit with the three headers and no-store', async () => {
    const harness = createHarness(fake, { config: limited });
    const first = await harness.request('/process', from('203.0.113.9'));
    await harness.request('/info', from('203.0.113.9'));
    const refused = await harness.request('/process', from('203.0.113.9'));
    expect(first.status).toBe(400);
    for (const name of RATE_LIMIT_HEADERS) {
      expect(first.headers.has(name)).toBe(false);
    }
    expect(refused.status).toBe(429);
    expect({
      retryAfter: refused.headers.get('retry-after'),
      rateLimit: refused.headers.get('ratelimit'),
      policy: refused.headers.get('ratelimit-policy'),
      cacheControl: refused.headers.get('cache-control'),
    }).toEqual({
      retryAfter: '30',
      rateLimit: '"default";r=0;t=30',
      policy: '"default";q=2;w=60',
      cacheControl: 'no-store',
    });
    expect(await refused.json()).toMatchObject({ code: 'rate_limited', status: 429 });
  });

  it('keys clients by the address the configured source gives', async () => {
    const harness = createHarness(fake, { config: limited });
    await harness.request('/process', from('203.0.113.9'));
    await harness.request('/process', from('203.0.113.9'));
    expect((await harness.request('/process', from('203.0.113.9'))).status).toBe(429);
    expect((await harness.request('/process', from('198.51.100.7'))).status).toBe(400);
  });

  it('reads the socket address the Node adapter binds', async () => {
    const harness = createHarness(fake, { config: { rateLimitPerMinute: 1 } });
    const socket = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });
    await harness.request('/process', undefined, socket('203.0.113.9'));
    expect((await harness.request('/process', undefined, socket('203.0.113.9'))).status).toBe(429);
    expect((await harness.request('/process', undefined, socket('198.51.100.7'))).status).toBe(400);
  });

  it('does not limit /health, unknown paths, or a 200 image response', async () => {
    const harness = createHarness(fake, { config: { rateLimitPerMinute: 1 } });
    const image = await harness.request(
      query('/process', { url: sourceUrl(fake, '/image/png'), width: '8' }),
    );
    expect(image.status).toBe(200);
    for (const name of RATE_LIMIT_HEADERS) {
      expect(image.headers.has(name)).toBe(false);
    }
    expect((await harness.request('/health')).status).toBe(200);
    expect((await harness.request('/health')).status).toBe(200);
    expect((await harness.request('/nothing-here')).status).toBe(404);
    expect((await harness.request('/nothing-here')).status).toBe(404);
  });
});
