import { generateImage } from '@image-service/fake-upstream/generator';
import { startFakeUpstream } from '@image-service/fake-upstream/server';
import type { SourceType } from '@image-service/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.ts';
import { createHarness, query, sourceUrl, type FakeUpstream } from './harness.ts';

let fake: FakeUpstream;

beforeAll(async () => {
  fake = await startFakeUpstream();
});

afterAll(async () => {
  await fake.close();
});

describe('GET /info', () => {
  const formats: SourceType[] = ['jpeg', 'png', 'webp', 'gif', 'avif', 'tiff'];

  for (const format of formats) {
    it(`describes a ${format} source by its sniffed type, dimensions, and size`, async () => {
      const { request } = createHarness(fake);
      const url = sourceUrl(fake, `/image/${format}?w=40&h=30`);
      const response = await request(query('/info', { url }));
      const generated = await generateImage({ width: 40, height: 30, format });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/^application\/json/);
      expect(await response.json()).toEqual({
        url,
        finalUrl: url,
        format,
        width: 40,
        height: 30,
        bytes: generated.bytes.byteLength,
        pages: 1,
      });
    });
  }

  it('reports the dimensions after EXIF orientation', async () => {
    const { request } = createHarness(fake);
    const url = sourceUrl(fake, '/image/jpeg?w=40&h=30&orientation=6');
    const response = await request(query('/info', { url }));
    expect(await response.json()).toMatchObject({ width: 30, height: 40 });
  });

  it('reports the URL after redirects as finalUrl', async () => {
    const { request } = createHarness(fake);
    const url = sourceUrl(fake, '/redirect?to=/image/png');
    const response = await request(query('/info', { url }));
    expect(await response.json()).toMatchObject({
      url,
      finalUrl: sourceUrl(fake, '/image/png'),
      format: 'png',
    });
  });
});

describe('GET /info and GET /process refuse bad URLs alike', () => {
  const cases: {
    name: string;
    url: () => string;
    status: number;
    code: string;
    config?: Partial<Config>;
  }[] = [
    {
      name: 'a value that is not a URL',
      url: () => 'not a url',
      status: 400,
      code: 'invalid_parameter',
    },
    {
      name: 'an ftp URL',
      url: () => 'ftp://images.example/a.png',
      status: 403,
      code: 'url_not_allowed',
    },
    {
      name: 'localhost',
      url: () => 'http://localhost/a.png',
      status: 403,
      code: 'url_not_allowed',
    },
    {
      name: 'a private address literal',
      url: () => 'http://10.0.0.1/a.png',
      status: 403,
      code: 'url_not_allowed',
    },
    {
      name: 'a loopback port outside ALLOWED_HOSTS',
      url: () => 'http://127.0.0.1:1/a.png',
      status: 403,
      code: 'url_not_allowed',
    },
    {
      name: 'an HTML source',
      url: () => sourceUrl(fake, '/html'),
      status: 415,
      code: 'unsupported_source_type',
    },
    {
      name: 'a truncated JPEG',
      url: () => sourceUrl(fake, '/truncated'),
      status: 415,
      code: 'unsupported_source_type',
    },
    {
      name: 'a source over MAX_SOURCE_BYTES',
      url: () => sourceUrl(fake, '/huge?bytes=1000001'),
      status: 413,
      code: 'source_too_large',
    },
    {
      name: 'a source over MAX_INPUT_PIXELS',
      url: () => sourceUrl(fake, '/image/png?w=2001&h=2000'),
      status: 413,
      code: 'source_too_large',
    },
    {
      name: 'an upstream 404',
      url: () => sourceUrl(fake, '/status/404'),
      status: 502,
      code: 'upstream_error',
    },
    {
      name: 'a gzip-encoded source',
      url: () => sourceUrl(fake, '/gzip'),
      status: 502,
      code: 'upstream_error',
    },
    {
      name: 'a redirect chain past MAX_REDIRECTS',
      url: () => sourceUrl(fake, '/redirect/chain/3?to=/image/png'),
      status: 502,
      code: 'too_many_redirects',
    },
    {
      name: 'a source slower than FETCH_TOTAL_TIMEOUT_MS',
      url: () => sourceUrl(fake, '/slow?ms=2000'),
      status: 504,
      code: 'upstream_timeout',
      config: { fetchTotalTimeoutMs: 200 },
    },
  ];

  for (const c of cases) {
    it(`answers ${c.name} with ${String(c.status)} ${c.code} on both`, async () => {
      const outcomes = [];
      for (const path of ['/info', '/process']) {
        const { request } = createHarness(fake, { config: c.config ?? {} });
        const response = await request(query(path, { url: c.url() }));
        outcomes.push({ status: response.status, body: await response.json() });
      }
      for (const outcome of outcomes) {
        expect(outcome).toMatchObject({ status: c.status, body: { code: c.code } });
      }
    });
  }
});
