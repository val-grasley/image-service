import { startFakeUpstream } from '@image-service/fake-upstream/server';
import type { ErrorCode } from '@image-service/sdk';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { ServiceError } from '../src/errors.ts';
import { toProblem } from '../src/http/errors.ts';
import { createHarness, query, sourceUrl, type FakeUpstream } from './harness.ts';

let fake: FakeUpstream;

beforeAll(async () => {
  fake = await startFakeUpstream();
});

afterAll(async () => {
  await fake.close();
});

const CODES = [
  { code: 'invalid_parameter', status: 400, title: 'Invalid parameter' },
  { code: 'url_not_allowed', status: 403, title: 'URL not allowed' },
  { code: 'not_found', status: 404, title: 'Not found' },
  { code: 'method_not_allowed', status: 405, title: 'Method not allowed' },
  { code: 'source_too_large', status: 413, title: 'Source too large' },
  { code: 'unsupported_source_type', status: 415, title: 'Unsupported source type' },
  { code: 'output_too_large', status: 422, title: 'Output too large' },
  { code: 'rate_limited', status: 429, title: 'Rate limited' },
  { code: 'internal_error', status: 500, title: 'Internal error' },
  { code: 'transform_timeout', status: 500, title: 'Transform timeout' },
  { code: 'upstream_error', status: 502, title: 'Upstream error' },
  { code: 'too_many_redirects', status: 502, title: 'Too many redirects' },
  { code: 'upstream_timeout', status: 504, title: 'Upstream timeout' },
] as const satisfies readonly { code: ErrorCode; status: number; title: string }[];

describe('toProblem', () => {
  it('has a row for every error code', () => {
    expectTypeOf<(typeof CODES)[number]['code']>().toEqualTypeOf<ErrorCode>();
  });

  for (const { code, status, title } of CODES) {
    it(`maps ${code} to ${String(status)} ${title} as problem details that are never stored`, () => {
      expect(toProblem(new ServiceError(code, 'What went wrong.'), 'req-1')).toEqual({
        status,
        body: {
          type: `/docs#error-${code}`,
          title,
          status,
          detail: 'What went wrong.',
          code,
          requestId: 'req-1',
        },
        headers: {
          'Content-Type': 'application/problem+json',
          'Cache-Control': 'no-store',
          'X-Request-Id': 'req-1',
        },
      });
    });
  }

  it('maps an unknown error to internal_error with no detail', () => {
    const error = new Error('ENOENT: no such file, open /var/task/secret.json', {
      cause: new Error('disk'),
    });
    expect(toProblem(error, 'req-2')).toMatchObject({
      status: 500,
      body: { code: 'internal_error', title: 'Internal error', detail: '' },
    });
  });

  it('adds Retry-After, RateLimit, and RateLimit-Policy to rate_limited', () => {
    const rateLimit = { allowed: false, limit: 60, remaining: 0, resetSeconds: 17 };
    const error = new ServiceError('rate_limited', 'Too many.', { rateLimit });
    expect(toProblem(error, 'req-3').headers).toMatchObject({
      'Retry-After': '17',
      RateLimit: '"default";r=0;t=17',
      'RateLimit-Policy': '"default";q=60;w=60',
    });
  });

  it('adds Allow to method_not_allowed', () => {
    const error = new ServiceError('method_not_allowed', 'No.', { allow: ['GET', 'HEAD'] });
    expect(toProblem(error, 'req-4').headers).toMatchObject({ Allow: 'GET, HEAD' });
  });

  it('carries field errors and the upstream status in the body', () => {
    const fields = [{ field: 'width', message: 'must be an integer between 1 and 4096' }];
    expect(
      toProblem(new ServiceError('invalid_parameter', 'Bad.', { fields }), 'req-5').body,
    ).toMatchObject({ errors: fields });
    expect(
      toProblem(new ServiceError('upstream_error', 'Bad.', { upstreamStatus: 404 }), 'req-6').body,
    ).toMatchObject({ upstreamStatus: 404 });
  });
});

describe('error responses', () => {
  it('logs a 5xx at error with the cause chain of the ServiceError', async () => {
    const closed = await startFakeUpstream();
    await closed.close();
    const harness = createHarness(fake, { config: { allowedHosts: new Set([closed.url.host]) } });
    const response = await harness.request(
      query('/process', { url: sourceUrl(closed, '/image/png') }),
      { headers: { 'X-Request-Id': 'refused' } },
    );
    expect(response.status).toBe(502);
    const line = harness.logs().find((entry) => entry.msg === 'request');
    expect(line).toMatchObject({
      level: 'error',
      requestId: 'refused',
      status: 502,
      code: 'upstream_error',
      err: { name: 'ServiceError' },
    });
    expect(JSON.stringify(line?.err)).toContain('ECONNREFUSED');
  });

  it('logs a 4xx at info with its code and no error', async () => {
    const harness = createHarness(fake);
    await harness.request(query('/process', { url: 'http://localhost/a.png' }));
    const line = harness.logs().find((entry) => entry.msg === 'request');
    expect(line).toMatchObject({ level: 'info', status: 403, code: 'url_not_allowed' });
    expect(line).not.toHaveProperty('err');
  });

  const sources = [
    '/status/500',
    '/status/404',
    '/html',
    '/truncated',
    '/truncated-pixels/jpeg',
    '/gzip',
    '/huge?bytes=1000001',
  ];

  for (const source of sources) {
    it(`gives a detail for ${source} with no path, stack frame, or upstream body`, async () => {
      const response = await createHarness(fake).request(
        query('/process', { url: sourceUrl(fake, source) }),
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      const { detail } = z.object({ detail: z.string() }).parse(await response.json());
      expect(detail).not.toBe('');
      expect(detail).not.toMatch(/(^|[\s(])\/[\w.-]+\//);
      expect(detail).not.toMatch(/\bat .+:\d+:\d+/);
      expect(detail).not.toMatch(/Status \d{3}/);
      expect(detail).not.toMatch(/<!doctype|<svg/i);
    });
  }
});
