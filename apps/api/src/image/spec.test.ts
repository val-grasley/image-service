import { describe, expect, it } from 'vitest';
import { cacheKey, toSpec, type TransformSpec } from './spec.ts';

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

  const changes: { name: string; spec: TransformSpec }[] = [
    { name: 'url', spec: { ...base, url: new URL('https://images.example/photos/dog.jpg') } },
    { name: 'width', spec: { ...base, width: 301 } },
    { name: 'height', spec: { ...base, height: 300 } },
    { name: 'crop', spec: { ...base, crop: 'fill' } },
    { name: 'format', spec: { ...base, format: 'png' } },
    { name: 'quality', spec: { ...base, quality: 81 } },
  ];
  for (const change of changes) {
    it(`changes when only the ${change.name} changes`, () => {
      expect(cacheKey(change.spec)).not.toBe(cacheKey(base));
    });
  }
});
