import { describe, expect, it } from 'vitest';
import { curlFor, infoUrl, processUrl, type ProcessParams } from './index.ts';

const base = 'https://img.example';
const source = 'https://src.example/photos/cat.jpg';
const encodedSource = 'https%3A%2F%2Fsrc.example%2Fphotos%2Fcat.jpg';

describe('processUrl', () => {
  const cases: { name: string; base: string | URL; params: ProcessParams; expected: string }[] = [
    {
      name: 'emits only url when nothing else is given',
      base,
      params: { url: source },
      expected: `${base}/process?url=${encodedSource}`,
    },
    {
      name: 'emits every parameter in the fixed order',
      base,
      params: { url: source, width: 300, height: 200, crop: 'fill', format: 'webp', quality: 70 },
      expected: `${base}/process?url=${encodedSource}&width=300&height=200&crop=fill&format=webp&quality=70`,
    },
    {
      name: 'ignores the key order of the parameter object',
      base,
      params: { quality: 70, format: 'webp', crop: 'fill', height: 200, width: 300, url: source },
      expected: `${base}/process?url=${encodedSource}&width=300&height=200&crop=fill&format=webp&quality=70`,
    },
    {
      name: 'omits absent parameters without adding defaults',
      base,
      params: { format: 'png', height: 50, url: source },
      expected: `${base}/process?url=${encodedSource}&height=50&format=png`,
    },
    {
      name: 'passes out-of-range values through for the service to reject',
      base,
      params: { url: source, width: 0, quality: 500 },
      expected: `${base}/process?url=${encodedSource}&width=0&quality=500`,
    },
    {
      name: 'encodes the query string and fragment of the source URL',
      base,
      params: { url: 'https://src.example/a b.png?size=large&v=2#top' },
      expected: `${base}/process?url=https%3A%2F%2Fsrc.example%2Fa+b.png%3Fsize%3Dlarge%26v%3D2%23top`,
    },
    {
      name: 'replaces the path and query of the base URL',
      base: new URL('http://127.0.0.1:3000/ui/index.html?debug=1'),
      params: { url: source, width: 10 },
      expected: `http://127.0.0.1:3000/process?url=${encodedSource}&width=10`,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(processUrl(c.base, c.params).href).toBe(c.expected);
    });
  }
});

describe('infoUrl', () => {
  it('puts the encoded source URL on /info', () => {
    expect(infoUrl(`${base}/anything`, source).href).toBe(`${base}/info?url=${encodedSource}`);
  });
});

describe('curlFor', () => {
  it('saves to out.<format> when the URL names a format', () => {
    const url = processUrl(base, { url: source, format: 'avif' });
    expect(curlFor(url)).toBe(`curl -sS -D - -o out.avif '${url.href}'`);
  });

  it('saves to out when the URL names no format', () => {
    const url = processUrl(base, { url: source, width: 100 });
    expect(curlFor(url)).toBe(`curl -sS -D - -o out '${url.href}'`);
  });

  it('saves to out when the format is not a known output format', () => {
    const url = new URL(`${base}/process?url=x&format=png;touch%20pwned`);
    expect(curlFor(url)).toBe(`curl -sS -D - -o out '${url.href}'`);
  });

  it('escapes single quotes in the URL', () => {
    expect(curlFor(new URL("https://img.example/it's"))).toBe(
      `curl -sS -D - -o out 'https://img.example/it'\\''s'`,
    );
  });
});
