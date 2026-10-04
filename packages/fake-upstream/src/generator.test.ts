import type { SourceType } from '@image-service/sdk';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { generateImage } from './generator.ts';

async function pixels(
  bytes: Uint8Array,
  options: { orient: boolean } = { orient: false },
): Promise<{ width: number; height: number; at(x: number, y: number): number[] }> {
  const image = options.orient ? sharp(bytes).autoOrient() : sharp(bytes);
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    at: (x, y) => {
      const offset = (y * info.width + x) * info.channels;
      return [...data.subarray(offset, offset + info.channels)];
    },
  };
}

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const YELLOW = [255, 255, 0];

describe('generateImage', () => {
  const formats: { format: SourceType; decodedAs: string }[] = [
    { format: 'jpeg', decodedAs: 'jpeg' },
    { format: 'png', decodedAs: 'png' },
    { format: 'webp', decodedAs: 'webp' },
    { format: 'gif', decodedAs: 'gif' },
    { format: 'avif', decodedAs: 'heif' },
    { format: 'tiff', decodedAs: 'tiff' },
  ];
  for (const { format, decodedAs } of formats) {
    it(`encodes ${format} at the requested dimensions`, async () => {
      const image = await generateImage({ width: 30, height: 20, format });
      const metadata = await sharp(image.bytes).metadata();
      expect(image).toMatchObject({ width: 30, height: 20, format });
      expect([metadata.format, metadata.width, metadata.height]).toEqual([decodedAs, 30, 20]);
    });
  }

  it('paints solid as a single color', async () => {
    const image = await generateImage({ width: 16, height: 12, format: 'png', pattern: 'solid' });
    const { channels } = await sharp(image.bytes).stats();
    expect(channels.every((channel) => channel.min === channel.max)).toBe(true);
  });

  it('paints quadrants as four distinct colors', async () => {
    const image = await generateImage({
      width: 40,
      height: 20,
      format: 'png',
      pattern: 'quadrants',
    });
    const raster = await pixels(image.bytes);
    expect([raster.at(5, 5), raster.at(35, 5), raster.at(5, 15), raster.at(35, 15)]).toEqual([
      RED,
      GREEN,
      BLUE,
      YELLOW,
    ]);
  });

  it('paints noise that compresses far worse than a solid color', async () => {
    const spec = { width: 128, height: 128, format: 'png' } as const;
    const noise = await generateImage({ ...spec, pattern: 'noise' });
    const solid = await generateImage({ ...spec, pattern: 'solid' });
    expect(noise.bytes.byteLength).toBeGreaterThan(128 * 128 * 3 * 0.9);
    expect(noise.bytes.byteLength).toBeGreaterThan(solid.bytes.byteLength * 20);
  });

  it('adds an alpha channel when asked', async () => {
    const image = await generateImage({ width: 8, height: 8, format: 'png', alpha: true });
    const metadata = await sharp(image.bytes).metadata();
    expect([metadata.hasAlpha, metadata.channels]).toEqual([true, 4]);
  });

  const tagged: SourceType[] = ['jpeg', 'png', 'webp', 'tiff'];
  for (const format of tagged) {
    it(`writes the orientation tag into ${format} without rotating the stored pixels`, async () => {
      const image = await generateImage({ width: 40, height: 20, format, orientation: 6 });
      const metadata = await sharp(image.bytes).metadata();
      expect([metadata.orientation, metadata.width, metadata.height]).toEqual([6, 40, 20]);
    });
  }

  const orientations: { orientation: 3 | 6 | 8; size: [number, number]; red: [number, number] }[] =
    [
      { orientation: 3, size: [40, 20], red: [35, 15] },
      { orientation: 6, size: [20, 40], red: [15, 5] },
      { orientation: 8, size: [20, 40], red: [5, 35] },
    ];
  for (const { orientation, size, red } of orientations) {
    it(`moves the top-left quadrant when orientation ${String(orientation)} is applied`, async () => {
      const image = await generateImage({
        width: 40,
        height: 20,
        format: 'png',
        pattern: 'quadrants',
        orientation,
      });
      const oriented = await pixels(image.bytes, { orient: true });
      expect([oriented.width, oriented.height]).toEqual(size);
      expect(oriented.at(...red)).toEqual(RED);
    });
  }

  const refused: {
    name: string;
    format: SourceType;
    extra: { orientation: 6 } | { alpha: true };
  }[] = [
    {
      name: 'an orientation for gif, which drops the tag',
      format: 'gif',
      extra: { orientation: 6 },
    },
    {
      name: 'an orientation for avif, which pre-rotates',
      format: 'avif',
      extra: { orientation: 6 },
    },
    { name: 'alpha for jpeg, which drops it', format: 'jpeg', extra: { alpha: true } },
    { name: 'alpha for tiff, which drops it', format: 'tiff', extra: { alpha: true } },
    {
      name: 'alpha for gif, which keeps only on-or-off transparency',
      format: 'gif',
      extra: { alpha: true },
    },
  ];
  for (const c of refused) {
    it(`refuses ${c.name}`, async () => {
      await expect(
        generateImage({ width: 8, height: 8, format: c.format, ...c.extra }),
      ).rejects.toThrow(RangeError);
    });
  }

  const transparent: SourceType[] = ['png', 'webp', 'avif'];
  for (const format of transparent) {
    it(`keeps the half-transparent alpha in ${format}`, async () => {
      const image = await generateImage({ width: 8, height: 8, format, alpha: true });
      const raster = await pixels(image.bytes);
      expect(raster.at(3, 3)[3]).toBe(128);
    });
  }

  it('returns the memoized result for an equal spec', async () => {
    const first = await generateImage({ width: 10, height: 10, format: 'webp', pattern: 'noise' });
    const again = await generateImage({ pattern: 'noise', format: 'webp', height: 10, width: 10 });
    const other = await generateImage({ width: 10, height: 11, format: 'webp', pattern: 'noise' });
    expect(again).toBe(first);
    expect(other).not.toBe(first);
  });
});
