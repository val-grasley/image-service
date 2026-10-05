import type { ProcessParams, SourceType } from '@image-service/sdk';
import { describe, expect, it } from 'vitest';
import { cacheKey, resolveEncoding, toSpec, type Encoding, type TransformSpec } from './spec.ts';

const defaults = { quality: 80 };
const href = 'https://images.example/photos/cat.jpg?size=large';

describe('toSpec', () => {
  it('applies the defaults for every omitted parameter', () => {
    expect(toSpec({ url: href }, defaults)).toEqual({
      url: new URL(href),
      width: undefined,
      height: undefined,
      crop: 'fit',
      format: 'source',
      quality: 80,
    });
  });

  const url = new URL(href);
  type Case = { name: string; params: ProcessParams; expect: TransformSpec };
  const cases: Case[] = [
    {
      name: 'drops a given quality for png output',
      params: { url: href, format: 'png', quality: 10 },
      expect: { url, width: undefined, height: undefined, crop: 'fit', format: 'png' },
    },
    {
      name: 'drops the default quality for png output',
      params: { url: href, format: 'png' },
      expect: { url, width: undefined, height: undefined, crop: 'fit', format: 'png' },
    },
    ...(['jpeg', 'webp', 'avif'] as const).map((format): Case => ({
      name: `keeps a given quality for ${format} output`,
      params: { url: href, format, quality: 10 },
      expect: {
        url,
        width: undefined,
        height: undefined,
        crop: 'fit',
        format,
        quality: 10,
      },
    })),
    {
      name: 'keeps quality for the source format, which may resolve to a lossy one',
      params: { url: href, quality: 10 },
      expect: {
        url,
        width: undefined,
        height: undefined,
        crop: 'fit',
        format: 'source',
        quality: 10,
      },
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(toSpec(c.params, defaults)).toStrictEqual(c.expect);
    });
  }

  it('keeps every parameter the caller gave', () => {
    expect(
      toSpec(
        { url: href, width: 300, height: 200, crop: 'pad', format: 'webp', quality: 55 },
        defaults,
      ),
    ).toEqual({
      url: new URL(href),
      width: 300,
      height: 200,
      crop: 'pad',
      format: 'webp',
      quality: 55,
    });
  });
});

describe('cacheKey', () => {
  const base: TransformSpec = toSpec({ url: href, width: 300 }, defaults);

  it('gives the documented canonical form, with the href as requested and defaults applied', () => {
    expect(cacheKey(base)).toBe(`v1|url=${href}|w=300|h=-|crop=fit|format=source|q=80`);
  });

  it('is identical for two specs with equal fields', () => {
    const again = toSpec({ url: href, width: 300, crop: 'fit', quality: 80 }, defaults);
    expect(cacheKey(again)).toBe(cacheKey(base));
  });

  const changes: { name: string; params: ProcessParams }[] = [
    { name: 'url', params: { url: 'https://images.example/photos/dog.jpg', width: 300 } },
    { name: 'width', params: { url: href, width: 301 } },
    { name: 'height', params: { url: href, width: 300, height: 300 } },
    { name: 'crop', params: { url: href, width: 300, crop: 'fill' } },
    { name: 'format', params: { url: href, width: 300, format: 'png' } },
    { name: 'quality', params: { url: href, width: 300, quality: 81 } },
  ];
  for (const change of changes) {
    it(`changes when only the ${change.name} changes`, () => {
      expect(cacheKey(toSpec(change.params, defaults))).not.toBe(cacheKey(base));
    });
  }

  it('gives png output no quality, so quality 10 and 90 share one key', () => {
    const low = toSpec({ url: href, format: 'png', quality: 10 }, defaults);
    const high = toSpec({ url: href, format: 'png', quality: 90 }, defaults);
    expect(cacheKey(low)).toBe(`v1|url=${href}|w=-|h=-|crop=fit|format=png|q=-`);
    expect(cacheKey(high)).toBe(cacheKey(low));
  });

  for (const format of ['jpeg', 'webp', 'avif', undefined] as const) {
    it(`keeps quality in the key for ${format ?? 'source'} output`, () => {
      const low = toSpec({ url: href, ...(format && { format }), quality: 10 }, defaults);
      const high = toSpec({ url: href, ...(format && { format }), quality: 90 }, defaults);
      expect(cacheKey(low)).not.toBe(cacheKey(high));
    });
  }
});

describe('resolveEncoding', () => {
  const cases: { name: string; params: ProcessParams; source: SourceType; expect: Encoding }[] = [
    {
      name: 'resolves an omitted format on a png source to png without quality',
      params: { url: href, quality: 10 },
      source: 'png',
      expect: { format: 'png' },
    },
    ...(['tiff', 'gif'] as const).map((source) => ({
      name: `resolves an omitted format on a ${source} source to png without quality`,
      params: { url: href, quality: 10 },
      source,
      expect: { format: 'png' as const },
    })),
    {
      name: 'resolves an omitted format on a jpeg source to jpeg with its quality',
      params: { url: href, quality: 10 },
      source: 'jpeg',
      expect: { format: 'jpeg', quality: 10 },
    },
    {
      name: 'keeps an explicit format regardless of the source',
      params: { url: href, format: 'webp', quality: 10 },
      source: 'png',
      expect: { format: 'webp', quality: 10 },
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(resolveEncoding(toSpec(c.params, defaults), c.source)).toStrictEqual(c.expect);
    });
  }
});
