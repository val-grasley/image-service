import { startFakeUpstream } from '@image-service/fake-upstream/server';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createHarness, query, sourceUrl, type FakeUpstream } from './harness.ts';

let fake: FakeUpstream;

beforeAll(async () => {
  fake = await startFakeUpstream();
});

afterAll(async () => {
  await fake.close();
});

async function decoded(response: Response) {
  const { format, width, height } = await sharp(await response.arrayBuffer()).metadata();
  return { format, width, height };
}

describe('GET /process', () => {
  // The brief's three example requests come first, then cases they leave uncovered: one
  // dimension only, and the PNG default for TIFF sources.
  const examples = [
    {
      name: 'fits a 1000 by 800 JPEG inside 500 by 300 with the aspect kept, since crop defaults to fit',
      source: '/image/jpeg?w=1000&h=800',
      params: { width: '500', height: '300' },
      expected: { format: 'jpeg', width: 375, height: 300 },
    },
    {
      name: 'converts a PNG to JPEG at quality 80 without resizing',
      source: '/image/png?w=640&h=480&pattern=quadrants',
      params: { format: 'jpeg', quality: '80' },
      expected: { format: 'jpeg', width: 640, height: 480 },
    },
    {
      name: 'fills exactly 800 by 600 from a 1200 by 800 PNG and encodes WebP',
      source: '/image/png?w=1200&h=800&pattern=quadrants',
      params: { width: '800', height: '600', format: 'webp', crop: 'fill' },
      expected: { format: 'webp', width: 800, height: 600 },
    },
    {
      name: 'resizes a JPEG to a width alone, keeping the aspect ratio and the format',
      source: '/image/jpeg?w=800&h=600',
      params: { width: '400' },
      expected: { format: 'jpeg', width: 400, height: 300 },
    },
    {
      name: 'resizes a TIFF to a height and returns PNG, the default for TIFF sources',
      source: '/image/tiff?w=320&h=240',
      params: { height: '120' },
      expected: { format: 'png', width: 160, height: 120 },
    },
  ];

  for (const example of examples) {
    it(example.name, async () => {
      const { request } = createHarness(fake);
      const response = await request(
        query('/process', { url: sourceUrl(fake, example.source), ...example.params }),
      );
      const { format, width, height } = example.expected;
      expect(response.status).toBe(200);
      expect({
        contentType: response.headers.get('content-type'),
        format: response.headers.get('x-image-format'),
        width: response.headers.get('x-image-width'),
        height: response.headers.get('x-image-height'),
      }).toEqual({
        contentType: `image/${format}`,
        format,
        width: String(width),
        height: String(height),
      });
      expect(await decoded(response)).toEqual(example.expected);
    });
  }

  it('sends every image header with its value and none of the upstream headers', async () => {
    const { request, config } = createHarness(fake);
    const response = await request(
      query('/process', { url: sourceUrl(fake, '/with-validators'), width: '32', format: 'png' }),
      { headers: { 'X-Request-Id': 'image-headers' } },
    );
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'content-type': 'image/png',
      'cache-control': `public, max-age=${String(config.resultCacheTtlSeconds)}`,
      'x-image-width': '32',
      'x-image-height': '24',
      'x-image-format': 'png',
      'x-result-cache': 'miss',
      'x-request-id': 'image-headers',
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
    });
    expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
    expect(response.headers.get('content-length')).toBe(
      String((await response.clone().arrayBuffer()).byteLength),
    );
    for (const upstreamHeader of ['set-cookie', 'x-powered-by', 'last-modified']) {
      expect(response.headers.has(upstreamHeader)).toBe(false);
    }
    expect(response.headers.get('etag')).not.toBe('"fake-upstream-1"');
  });

  it('answers HEAD with the headers of GET and no body', async () => {
    const path = query('/process', { url: sourceUrl(fake, '/image/webp'), width: '20' });
    const init = { headers: { 'X-Request-Id': 'head-matches-get' } };
    const get = await createHarness(fake).request(path, init);
    const head = await createHarness(fake).request(path, { ...init, method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(Object.fromEntries(head.headers)).toEqual(Object.fromEntries(get.headers));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    const body = await get.arrayBuffer();
    expect(body.byteLength).toBeGreaterThan(0);
    expect(head.headers.get('content-length')).toBe(String(body.byteLength));
  });

  it('answers a request carrying the returned ETag with 304 and no body', async () => {
    const { request, config } = createHarness(fake);
    const path = query('/process', { url: sourceUrl(fake, '/image/png'), width: '16' });
    const first = await request(path);
    const etag = first.headers.get('etag') ?? '';
    const second = await request(path, {
      headers: { 'If-None-Match': etag, 'X-Request-Id': 'revalidate' },
    });
    expect(second.status).toBe(304);
    expect((await second.arrayBuffer()).byteLength).toBe(0);
    expect({
      etag: second.headers.get('etag'),
      cacheControl: second.headers.get('cache-control'),
      requestId: second.headers.get('x-request-id'),
    }).toEqual({
      etag,
      cacheControl: `public, max-age=${String(config.resultCacheTtlSeconds)}`,
      requestId: 'revalidate',
    });
  });
});

describe('GET /process validation', () => {
  const digits = 'written as digits without a sign or leading zeros';
  const integer1To1024 = `must be an integer between 1 and 1024, ${digits}`;
  const integer1To100 = `must be an integer between 1 and 100, ${digits}`;
  const absoluteUrl = 'must be an absolute URL';
  const unknownParameter = 'not accepted; use url, width, height, crop, format, quality';
  const cases: { name: string; params: Record<string, string>; field: string; message: string }[] =
    [
      {
        name: 'a url that is not a URL',
        params: { url: 'not a url' },
        field: 'url',
        message: absoluteUrl,
      },
      { name: 'a relative url', params: { url: '/image/png' }, field: 'url', message: absoluteUrl },
      { name: 'a width of 0', params: { width: '0' }, field: 'width', message: integer1To1024 },
      {
        name: 'a width above MAX_OUTPUT_DIMENSION',
        params: { width: '1025' },
        field: 'width',
        message: integer1To1024,
      },
      {
        name: 'a fractional width',
        params: { width: '1.5' },
        field: 'width',
        message: integer1To1024,
      },
      {
        name: 'a width that is not a number',
        params: { width: 'wide' },
        field: 'width',
        message: integer1To1024,
      },
      { name: 'a height of 0', params: { height: '0' }, field: 'height', message: integer1To1024 },
      {
        name: 'an unknown crop',
        params: { crop: 'stretch' },
        field: 'crop',
        message: 'must be one of fit, fill, scale, pad',
      },
      {
        name: 'an unknown format',
        params: { format: 'gif' },
        field: 'format',
        message: 'must be one of jpeg, png, webp, avif',
      },
      {
        name: 'a quality of 0',
        params: { quality: '0' },
        field: 'quality',
        message: integer1To100,
      },
      {
        name: 'a quality of 101',
        params: { quality: '101' },
        field: 'quality',
        message: integer1To100,
      },
    ];

  for (const c of cases) {
    it(`refuses ${c.name} with a field error naming ${c.field}`, async () => {
      const { request } = createHarness(fake);
      const response = await request(
        query('/process', { url: sourceUrl(fake, '/image/png'), ...c.params }),
      );
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect(await response.json()).toMatchObject({
        code: 'invalid_parameter',
        status: 400,
        errors: [{ field: c.field, message: c.message }],
      });
    });
  }

  const integerParameters = [
    { field: 'width', max: '1024', message: integer1To1024 },
    { field: 'height', max: '1024', message: integer1To1024 },
    { field: 'quality', max: '100', message: integer1To100 },
  ];
  // Number() parses each of these; the in-range ones would be second spellings of 5.
  const nonCanonical = ['05', '00', '5.0', '0x5', '5e0', '+5', '-5', ' 5', '5 ', ''];

  for (const { field, message } of integerParameters) {
    for (const spelling of nonCanonical) {
      it(`refuses ${field}=${JSON.stringify(spelling)} with the message saying what is accepted`, async () => {
        const { request } = createHarness(fake);
        const response = await request(
          query('/process', { url: sourceUrl(fake, '/image/png'), [field]: spelling }),
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ errors: [{ field, message }] });
      });
    }
  }

  for (const { field, max } of integerParameters) {
    for (const value of ['1', '9', '10', max]) {
      it(`accepts ${field}=${value}, a plain decimal within range`, async () => {
        const { request } = createHarness(fake);
        const response = await request(
          query('/process', { url: sourceUrl(fake, '/image/png'), [field]: value }),
        );
        expect(response.status).toBe(200);
      });
    }
  }

  it('refuses a missing url with a field error naming url', async () => {
    const { request } = createHarness(fake);
    const response = await request(query('/process', { width: '10' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'invalid_parameter',
      errors: [{ field: 'url', message: absoluteUrl }],
    });
  });

  it('reports every invalid parameter, each once', async () => {
    const { request } = createHarness(fake);
    const response = await request(
      query('/process', { url: sourceUrl(fake, '/image/png'), width: '0', crop: 'stretch' }),
    );
    expect(await response.json()).toMatchObject({
      errors: [
        { field: 'width', message: integer1To1024 },
        { field: 'crop', message: 'must be one of fit, fill, scale, pad' },
      ],
    });
  });

  it('refuses width times height above MAX_OUTPUT_PIXELS as a width error, without fetching', async () => {
    const { request } = createHarness(fake);
    const before = fake.requests().length;
    const response = await request(
      query('/process', { url: sourceUrl(fake, '/image/png'), width: '1024', height: '1000' }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      errors: [{ field: 'width', message: 'width times height must be at most 1000000 pixels' }],
    });
    expect(fake.requests()).toHaveLength(before);
  });

  // Pairs rather than a record, so a case can repeat a key.
  const unknownCases: {
    name: string;
    params: () => [string, string][];
    errors: { field: string; message: string }[];
  }[] = [
    {
      name: 'a misspelled parameter, naming it',
      params: () => [
        ['url', sourceUrl(fake, '/image/png')],
        ['widht', '5'],
      ],
      errors: [{ field: 'widht', message: unknownParameter }],
    },
    {
      name: 'a parameter whose case differs from a known one, naming it',
      params: () => [
        ['url', sourceUrl(fake, '/image/png')],
        ['Width', '5'],
      ],
      errors: [{ field: 'Width', message: unknownParameter }],
    },
    {
      name: 'two unknown parameters, naming each',
      params: () => [
        ['url', sourceUrl(fake, '/image/png')],
        ['v', '2'],
        ['cachebust', '1'],
      ],
      errors: [
        { field: 'v', message: unknownParameter },
        { field: 'cachebust', message: unknownParameter },
      ],
    },
    {
      name: 'an unknown parameter given twice, naming it once',
      params: () => [
        ['url', sourceUrl(fake, '/image/png')],
        ['v', '1'],
        ['v', '2'],
      ],
      errors: [{ field: 'v', message: unknownParameter }],
    },
    {
      name: 'an unknown parameter beside an invalid known one, naming both',
      params: () => [
        ['url', sourceUrl(fake, '/image/png')],
        ['width', '0'],
        ['widht', '5'],
      ],
      errors: [
        { field: 'width', message: integer1To1024 },
        { field: 'widht', message: unknownParameter },
      ],
    },
    {
      name: 'a source URL left unencoded, naming the parameter its own query string spilled',
      params: () => [
        ['url', sourceUrl(fake, '/image/png?w=10')],
        ['h', '20'],
      ],
      errors: [{ field: 'h', message: unknownParameter }],
    },
  ];

  for (const c of unknownCases) {
    it(`refuses ${c.name}, without fetching`, async () => {
      const { request } = createHarness(fake);
      const before = fake.requests().length;
      const response = await request(`/process?${new URLSearchParams(c.params()).toString()}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'invalid_parameter', errors: c.errors });
      expect(fake.requests()).toHaveLength(before);
    });
  }

  it('answers pairs with an empty name, which the query parser drops before validation', async () => {
    const { request } = createHarness(fake);
    const params = new URLSearchParams({ url: sourceUrl(fake, '/image/png'), width: '10' });
    const response = await request(`/process?${params.toString()}&=5&&`);
    expect(response.status).toBe(200);
  });

  it('refuses a known parameter given twice as an error on that parameter', async () => {
    const { request } = createHarness(fake);
    const params = new URLSearchParams([
      ['url', sourceUrl(fake, '/image/png')],
      ['width', '10'],
      ['width', '20'],
    ]);
    const response = await request(`/process?${params.toString()}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      errors: [{ field: 'width', message: integer1To1024 }],
    });
  });

  it('answers an unknown parameter with a complete invalid_parameter problem', async () => {
    const { request } = createHarness(fake);
    const response = await request(
      query('/process', { url: sourceUrl(fake, '/image/png'), widht: '5' }),
      { headers: { 'X-Request-Id': 'unknown-parameter' } },
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      type: '/docs#error-invalid_parameter',
      title: 'Invalid parameter',
      status: 400,
      detail: 'Invalid query parameters: widht.',
      code: 'invalid_parameter',
      requestId: 'unknown-parameter',
      errors: [{ field: 'widht', message: unknownParameter }],
    });
  });
});

describe('GET /process output limits', () => {
  it('refuses an avif output above MAX_AVIF_OUTPUT_PIXELS with 422 and accepts a smaller one', async () => {
    const { request } = createHarness(fake, { config: { maxAvifOutputPixels: 100_000 } });
    const url = sourceUrl(fake, '/image/png?w=640&h=480');
    const refused = await request(query('/process', { url, format: 'avif' }));
    expect(refused.status).toBe(422);
    const problem = z.object({ code: z.string(), detail: z.string() }).parse(await refused.json());
    expect(problem.code).toBe('output_too_large');
    expect(problem.detail).toContain('MAX_AVIF_OUTPUT_PIXELS');
    const accepted = await request(query('/process', { url, format: 'avif', width: '320' }));
    expect(accepted.status).toBe(200);
    expect(await decoded(accepted)).toEqual({ format: 'heif', width: 320, height: 240 });
  });

  const problem = z.object({ code: z.string(), detail: z.string() });

  for (const format of ['png', 'jpeg', 'webp']) {
    it(`refuses a ${format} whose derived height exceeds MAX_OUTPUT_DIMENSION with 422`, async () => {
      // The default limits: a width of 4096 is valid, and fill derives the height from a 1:1000 source.
      const { request } = createHarness(fake, {
        config: { maxOutputDimension: 4096, maxOutputPixels: 16_000_000 },
      });
      const url = sourceUrl(fake, '/image/png?w=4&h=4000');
      const response = await request(
        query('/process', { url, crop: 'fill', width: '4096', format }),
      );
      expect(response.status).toBe(422);
      expect(problem.parse(await response.json())).toEqual({
        code: 'output_too_large',
        detail:
          'The output would be 4096 by 4096000 (16777216000 pixels); MAX_OUTPUT_DIMENSION allows at most 4096 on each side; request smaller dimensions.',
      });
    });
  }

  it('refuses an enlarging resize whose output is above MAX_OUTPUT_PIXELS with 422', async () => {
    const { request } = createHarness(fake);
    const url = sourceUrl(fake, '/image/png?w=100&h=99');
    const response = await request(query('/process', { url, crop: 'fill', width: '1024' }));
    expect(response.status).toBe(422);
    expect(problem.parse(await response.json())).toEqual({
      code: 'output_too_large',
      detail:
        'The output would be 1024 by 1014 (1038336 pixels); MAX_OUTPUT_PIXELS allows at most 1000000; request smaller dimensions.',
    });
  });

  it('refuses an enlarging resize whose derived side is above MAX_OUTPUT_DIMENSION with 422', async () => {
    const { request } = createHarness(fake);
    const url = sourceUrl(fake, '/image/png?w=100&h=200');
    const response = await request(query('/process', { url, crop: 'fill', width: '600' }));
    expect(response.status).toBe(422);
    expect(problem.parse(await response.json()).detail).toBe(
      'The output would be 600 by 1200 (720000 pixels); MAX_OUTPUT_DIMENSION allows at most 1024 on each side; request smaller dimensions.',
    );
  });

  it('accepts an enlarging resize exactly at MAX_OUTPUT_PIXELS and at MAX_OUTPUT_DIMENSION', async () => {
    const { request } = createHarness(fake);
    const atPixels = await request(
      query('/process', {
        url: sourceUrl(fake, '/image/png?w=10&h=10'),
        crop: 'fill',
        width: '1000',
      }),
    );
    const atDimension = await request(
      query('/process', {
        url: sourceUrl(fake, '/image/png?w=100&h=50'),
        crop: 'scale',
        width: '1024',
      }),
    );
    expect([atPixels.status, atDimension.status]).toEqual([200, 200]);
    expect(await decoded(atPixels)).toEqual({ format: 'png', width: 1000, height: 1000 });
    expect(await decoded(atDimension)).toEqual({ format: 'png', width: 1024, height: 512 });
  });

  it('returns a resize no larger than the source with 200 even when the source is over the output limits', async () => {
    const { request } = createHarness(fake);
    // fit never enlarges, so each output is the source size, which MAX_INPUT_PIXELS bounds.
    const overPixels = await request(
      query('/process', { url: sourceUrl(fake, '/image/png?w=1000&h=1001'), width: '1000' }),
    );
    const overDimension = await request(
      query('/process', { url: sourceUrl(fake, '/image/png?w=10&h=1025'), width: '10' }),
    );
    expect([overPixels.status, overDimension.status]).toEqual([200, 200]);
    expect(await decoded(overPixels)).toEqual({ format: 'png', width: 1000, height: 1001 });
    expect(await decoded(overDimension)).toEqual({ format: 'png', width: 10, height: 1025 });
  });

  it('returns a source above MAX_OUTPUT_PIXELS or wider than MAX_OUTPUT_DIMENSION at its own size when no dimension is given', async () => {
    const { request } = createHarness(fake);
    const overPixels = await request(
      query('/process', { url: sourceUrl(fake, '/image/png?w=1000&h=1001') }),
    );
    const overDimension = await request(
      query('/process', { url: sourceUrl(fake, '/image/png?w=1025&h=10') }),
    );
    expect([overPixels.status, overDimension.status]).toEqual([200, 200]);
    expect(await decoded(overPixels)).toEqual({ format: 'png', width: 1000, height: 1001 });
    expect(await decoded(overDimension)).toEqual({ format: 'png', width: 1025, height: 10 });
  });

  it('applies the AVIF cap to an avif output even when no dimension is given', async () => {
    const { request, config } = createHarness(fake);
    const url = sourceUrl(fake, '/image/png?w=800&h=700');
    const avif = await request(query('/process', { url, format: 'avif' }));
    const webp = await request(query('/process', { url, format: 'webp' }));
    expect(config.maxAvifOutputPixels).toBeLessThan(800 * 700);
    expect([avif.status, webp.status]).toEqual([422, 200]);
    expect(problem.parse(await avif.json()).detail).toContain('MAX_AVIF_OUTPUT_PIXELS');
  });
});

describe('GET /process on a source whose header reads but whose pixels do not decode', () => {
  for (const format of ['jpeg', 'png']) {
    it(`answers a truncated ${format} with 415 unsupported_source_type, while /info describes it`, async () => {
      const { request } = createHarness(fake);
      const url = sourceUrl(fake, `/truncated-pixels/${format}`);
      const processed = await request(query('/process', { url, width: '100' }));
      expect(processed.status).toBe(415);
      expect(await processed.json()).toMatchObject({
        code: 'unsupported_source_type',
        detail: 'The source image could not be decoded; it may be truncated or corrupt.',
      });
      const described = await request(query('/info', { url }));
      expect(described.status).toBe(200);
      expect(await described.json()).toMatchObject({ format, width: 300, height: 200 });
    });
  }
});
