import { generateImage } from '@image-service/fake-upstream/generator';
import type { CropMode } from '@image-service/sdk';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.ts';
import { outputDimensions } from './dimensions.ts';
import { inspect, transform } from './pipeline.ts';
import { toSpec } from './spec.ts';

type Size = { width: number; height: number };

// `source` is always the oriented size; with `orientation` 6 the file stores it rotated.
const cases: {
  name: string;
  source: Size;
  orientation?: 6;
  spec: { width?: number; height?: number; crop: CropMode };
  expect: Size;
}[] = [
  {
    name: 'fit with no dimensions keeps the source size',
    source: { width: 400, height: 200 },
    spec: { crop: 'fit' },
    expect: { width: 400, height: 200 },
  },
  {
    name: 'scale with no dimensions keeps the source size',
    source: { width: 400, height: 200 },
    spec: { crop: 'scale' },
    expect: { width: 400, height: 200 },
  },
  {
    name: 'fit inside a square box keeps the aspect ratio',
    source: { width: 400, height: 200 },
    spec: { width: 100, height: 100, crop: 'fit' },
    expect: { width: 100, height: 50 },
  },
  {
    name: 'fill produces exactly the box',
    source: { width: 400, height: 200 },
    spec: { width: 100, height: 100, crop: 'fill' },
    expect: { width: 100, height: 100 },
  },
  {
    name: 'scale produces exactly the box',
    source: { width: 400, height: 200 },
    spec: { width: 100, height: 100, crop: 'scale' },
    expect: { width: 100, height: 100 },
  },
  {
    name: 'pad produces exactly the box',
    source: { width: 400, height: 200 },
    spec: { width: 100, height: 100, crop: 'pad' },
    expect: { width: 100, height: 100 },
  },
  {
    name: 'fit with a width alone derives the height from the aspect ratio',
    source: { width: 400, height: 200 },
    spec: { width: 200, crop: 'fit' },
    expect: { width: 200, height: 100 },
  },
  {
    name: 'fit with a height alone derives the width from the aspect ratio',
    source: { width: 400, height: 200 },
    spec: { height: 50, crop: 'fit' },
    expect: { width: 100, height: 50 },
  },
  {
    name: 'fill with a width alone derives the height from the aspect ratio',
    source: { width: 400, height: 200 },
    spec: { width: 200, crop: 'fill' },
    expect: { width: 200, height: 100 },
  },
  {
    name: 'pad with a height alone derives the width from the aspect ratio',
    source: { width: 400, height: 200 },
    spec: { height: 50, crop: 'pad' },
    expect: { width: 100, height: 50 },
  },
  {
    name: 'scale with a width alone keeps the source height',
    source: { width: 400, height: 200 },
    spec: { width: 200, crop: 'scale' },
    expect: { width: 200, height: 200 },
  },
  {
    name: 'scale with a height alone keeps the source width',
    source: { width: 400, height: 200 },
    spec: { height: 50, crop: 'scale' },
    expect: { width: 400, height: 50 },
  },
  {
    name: 'fit never enlarges past a larger box',
    source: { width: 400, height: 200 },
    spec: { width: 1000, height: 1000, crop: 'fit' },
    expect: { width: 400, height: 200 },
  },
  {
    name: 'fit never enlarges past a larger width alone',
    source: { width: 400, height: 200 },
    spec: { width: 1000, crop: 'fit' },
    expect: { width: 400, height: 200 },
  },
  {
    name: 'fit never enlarges past a larger height alone',
    source: { width: 400, height: 200 },
    spec: { height: 1000, crop: 'fit' },
    expect: { width: 400, height: 200 },
  },
  {
    name: 'fill enlarges to a larger width alone',
    source: { width: 400, height: 200 },
    spec: { width: 1000, crop: 'fill' },
    expect: { width: 1000, height: 500 },
  },
  {
    name: 'pad enlarges to a larger height alone',
    source: { width: 400, height: 200 },
    spec: { height: 1000, crop: 'pad' },
    expect: { width: 2000, height: 1000 },
  },
  {
    name: 'fill enlarges to a larger box',
    source: { width: 400, height: 200 },
    spec: { width: 1000, height: 1000, crop: 'fill' },
    expect: { width: 1000, height: 1000 },
  },
  {
    name: 'fit rounds a derived height to the nearest pixel',
    source: { width: 333, height: 777 },
    spec: { width: 101, crop: 'fit' },
    expect: { width: 101, height: 236 },
  },
  {
    name: 'fit rounds a derived width to the nearest pixel',
    source: { width: 333, height: 777 },
    spec: { height: 101, crop: 'fit' },
    expect: { width: 43, height: 101 },
  },
  {
    name: 'fit rounds a derived dimension of exactly one half up',
    source: { width: 4, height: 6 },
    spec: { width: 3, crop: 'fit' },
    expect: { width: 3, height: 5 },
  },
  {
    name: 'fit keeps a derived dimension at one pixel at least',
    source: { width: 1001, height: 3 },
    spec: { width: 7, crop: 'fit' },
    expect: { width: 7, height: 1 },
  },
  {
    name: 'fit never shrinks a box-bound axis below one pixel',
    source: { width: 999, height: 1000 },
    spec: { width: 1, height: 1, crop: 'fit' },
    expect: { width: 1, height: 1 },
  },
  {
    name: 'fit works from the oriented size of a source stored rotated',
    source: { width: 200, height: 400 },
    orientation: 6,
    spec: { width: 100, crop: 'fit' },
    expect: { width: 100, height: 200 },
  },
  {
    name: 'fit takes the tighter of the two dimensions without enlarging',
    source: { width: 5, height: 5 },
    spec: { width: 4096, height: 3, crop: 'fit' },
    expect: { width: 3, height: 3 },
  },
];

const limits = parseConfig({});

describe('outputDimensions', () => {
  for (const c of cases) {
    it(c.name, () => {
      expect(
        outputDimensions(c.source, { width: undefined, height: undefined, ...c.spec }),
      ).toEqual(c.expect);
    });
  }
});

describe('outputDimensions agrees with what transform produces', () => {
  for (const c of cases) {
    it(c.name, async () => {
      const source = await generateImage(
        c.orientation === undefined
          ? { ...c.source, format: 'png' }
          : {
              width: c.source.height,
              height: c.source.width,
              format: 'png',
              orientation: c.orientation,
            },
      );
      const spec = toSpec({ url: 'https://images.example/source', ...c.spec }, { quality: 80 });
      const result = await transform(
        source.bytes,
        await inspect(source.bytes, source.format),
        spec,
        limits,
      );
      expect({ width: result.width, height: result.height }).toEqual(c.expect);
    });
  }
});
