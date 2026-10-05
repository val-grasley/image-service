import { createHash } from 'node:crypto';
import { generateImage } from '@image-service/fake-upstream/generator';
import { startFakeUpstream } from '@image-service/fake-upstream/server';
import type { ProcessParams } from '@image-service/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspect, pipelineVersion, transform } from '../src/image/pipeline.ts';
import { cacheKey, toSpec } from '../src/image/spec.ts';
import { createHarness, query, sourceUrl, type FakeUpstream } from './harness.ts';
import { testConfig } from './test-config.ts';

let fake: FakeUpstream;

beforeAll(async () => {
  fake = await startFakeUpstream();
});

afterAll(async () => {
  await fake.close();
});

const sha256 = (input: string | Uint8Array): string =>
  createHash('sha256').update(input).digest('hex');

// The ETag as design/caching.md specifies it, computed independently of the operation.
function expectedEtag(params: ProcessParams, sourceIdentity: string, version = pipelineVersion()) {
  const key = cacheKey(toSpec(params, { quality: testConfig().defaultQuality }));
  return `"${sha256(`${key}|${version}|${sourceIdentity}`).slice(0, 32)}"`;
}

async function etagOf(params: ProcessParams, harness = createHarness(fake)): Promise<string> {
  const response = await harness.request(query('/process', toQuery(params)));
  expect(response.status).toBe(200);
  return response.headers.get('etag') ?? '';
}

function toQuery(params: ProcessParams): Record<string, string> {
  return Object.fromEntries(Object.entries(params).map(([name, value]) => [name, String(value)]));
}

function recordingPipeline() {
  const calls = { transform: 0 };
  return {
    calls,
    pipeline: {
      inspect,
      pipelineVersion,
      transform: (...args: Parameters<typeof transform>) => {
        calls.transform += 1;
        return transform(...args);
      },
    },
  };
}

describe('ETag', () => {
  const withValidators = (search = '') => sourceUrl(fake, `/with-validators${search}`);
  const DEFAULT_LAST_MODIFIED = 'Wed, 01 Jan 2025 00:00:00 GMT';

  it('is the same for repeated requests and is built from the upstream ETag', async () => {
    const params = { url: withValidators(), width: 32 };
    const first = await etagOf(params);
    const second = await etagOf(params);
    expect(second).toBe(first);
    expect(first).toBe(expectedEtag(params, '"fake-upstream-1"'));
  });

  it('changes when the spec changes', async () => {
    const narrow = { url: withValidators(), width: 32 };
    const wide = { url: withValidators(), width: 48 };
    const [a, b] = [await etagOf(narrow), await etagOf(wide)];
    expect(a).not.toBe(b);
    expect(b).toBe(expectedEtag(wide, '"fake-upstream-1"'));
  });

  it('changes when the upstream ETag changes', async () => {
    const v1 = { url: withValidators('?etag=%22v1%22'), width: 32 };
    const v2 = { url: withValidators('?etag=%22v2%22'), width: 32 };
    const [a, b] = [await etagOf(v1), await etagOf(v2)];
    expect(a).not.toBe(b);
    expect([a, b]).toEqual([expectedEtag(v1, '"v1"'), expectedEtag(v2, '"v2"')]);
  });

  it('uses Last-Modified when the upstream sends no ETag', async () => {
    const params = { url: withValidators('?etag='), width: 32 };
    expect(await etagOf(params)).toBe(expectedEtag(params, `lm:${DEFAULT_LAST_MODIFIED}`));
  });

  it('falls back to a hash of the source bytes when the upstream sends no validators', async () => {
    const params = { url: withValidators('?etag=&lastModified='), width: 32 };
    const source = await generateImage({ width: 64, height: 48, format: 'jpeg' });
    expect(await etagOf(params)).toBe(expectedEtag(params, `sha256:${sha256(source.bytes)}`));
  });

  it('changes with the source bytes when the upstream sends no validators', async () => {
    const solid = { url: sourceUrl(fake, '/image/png?w=40&h=30'), width: 20 };
    const quadrants = { url: sourceUrl(fake, '/image/png?w=40&h=30&pattern=quadrants'), width: 20 };
    const solidBytes = await generateImage({ width: 40, height: 30, format: 'png' });
    const quadrantBytes = await generateImage({
      width: 40,
      height: 30,
      format: 'png',
      pattern: 'quadrants',
    });
    expect(await etagOf(solid)).toBe(expectedEtag(solid, `sha256:${sha256(solidBytes.bytes)}`));
    expect(await etagOf(quadrants)).toBe(
      expectedEtag(quadrants, `sha256:${sha256(quadrantBytes.bytes)}`),
    );
  });

  it('changes when the pipeline version changes', async () => {
    const params = { url: withValidators(), width: 32 };
    const nextVersion = `${pipelineVersion()}-next`;
    const harness = createHarness(fake, {
      pipeline: { inspect, transform, pipelineVersion: () => nextVersion },
    });
    const changed = await etagOf(params, harness);
    expect(changed).not.toBe(await etagOf(params));
    expect(changed).toBe(expectedEtag(params, '"fake-upstream-1"', nextVersion));
  });
});

describe('conditional requests', () => {
  const path = () => query('/process', { url: sourceUrl(fake, '/with-validators'), width: '24' });

  it('answers a matching If-None-Match on a result-cache hit with 304 and no fetch', async () => {
    const harness = createHarness(fake);
    const etag = (await harness.request(path())).headers.get('etag') ?? '';
    const fetched = fake.requests().length;
    const response = await harness.request(path(), { headers: { 'If-None-Match': etag } });
    expect(response.status).toBe(304);
    expect(fake.requests()).toHaveLength(fetched);
  });

  it('answers a matching If-None-Match on a miss with 304 after one fetch and no transform', async () => {
    const etag = (await createHarness(fake).request(path())).headers.get('etag') ?? '';
    const { calls, pipeline } = recordingPipeline();
    const harness = createHarness(fake, { pipeline });
    const fetched = fake.requests().length;
    const response = await harness.request(path(), { headers: { 'If-None-Match': etag } });
    expect(response.status).toBe(304);
    expect(fake.requests()).toHaveLength(fetched + 1);
    expect(calls.transform).toBe(0);
  });

  it('answers a non-matching If-None-Match with the image', async () => {
    const response = await createHarness(fake).request(path(), {
      headers: { 'If-None-Match': '"0123456789abcdef0123456789abcdef"' },
    });
    expect(response.status).toBe(200);
  });

  it('matches a weak tag, one entry of a list, and the wildcard', async () => {
    const harness = createHarness(fake);
    const etag = (await harness.request(path())).headers.get('etag') ?? '';
    for (const header of [`W/${etag}`, `"other", ${etag}`, '*']) {
      const response = await harness.request(path(), { headers: { 'If-None-Match': header } });
      expect(response.status).toBe(304);
    }
  });
});

describe('X-Result-Cache', () => {
  it('is miss and then hit for two identical requests on one app', async () => {
    const harness = createHarness(fake);
    const path = query('/process', { url: sourceUrl(fake, '/image/jpeg'), width: '30' });
    const first = await harness.request(path);
    const second = await harness.request(path);
    expect([first.headers.get('x-result-cache'), second.headers.get('x-result-cache')]).toEqual([
      'miss',
      'hit',
    ]);
    expect(second.headers.get('etag')).toBe(first.headers.get('etag'));
  });

  it('is a hit with the same ETag for a png request differing only in quality', async () => {
    const harness = createHarness(fake);
    const params = { url: sourceUrl(fake, '/image/jpeg'), width: '30', format: 'png' };
    const low = await harness.request(query('/process', { ...params, quality: '10' }));
    const high = await harness.request(query('/process', { ...params, quality: '90' }));
    expect([low.headers.get('x-result-cache'), high.headers.get('x-result-cache')]).toEqual([
      'miss',
      'hit',
    ]);
    expect(high.headers.get('etag')).toBe(low.headers.get('etag'));
  });
});

describe('URL rules before the caches', () => {
  for (const path of ['/process', '/info']) {
    it(`refuses on ${path} a URL the policy denies even when another app cached it`, async () => {
      const allowed = createHarness(fake);
      const url = sourceUrl(fake, '/image/png?w=12&h=12');
      const target = query(path, { url, ...(path === '/process' && { width: '6' }) });
      expect((await allowed.request(target)).status).toBe(200);
      const denying = createHarness(fake, {
        config: { allowedHosts: new Set() },
        caches: allowed.caches,
      });
      const fetched = fake.requests().length;
      const response = await denying.request(target);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'url_not_allowed' });
      expect(fake.requests()).toHaveLength(fetched);
    });
  }
});
