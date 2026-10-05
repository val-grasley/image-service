import { generateImage } from '@image-service/fake-upstream/generator';
import type { OutputFormat, ProcessParams, SourceType } from '@image-service/sdk';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.ts';
import { ServiceError } from '../errors.ts';
import {
  PIPELINE_REVISION,
  fromSharpError,
  inspect,
  pipelineVersion,
  transform,
  type TransformResult,
} from './pipeline.ts';
import { toSpec } from './spec.ts';

const limits = parseConfig({});

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const YELLOW = [255, 255, 0];

async function run(
  source: { bytes: Uint8Array; format: SourceType },
  params: Omit<ProcessParams, 'url'>,
  overrides: Partial<typeof limits> = {},
): Promise<TransformResult> {
  const info = await inspect(source.bytes, source.format);
  const spec = toSpec({ url: 'https://images.example/source', ...params }, { quality: 80 });
  return transform(source.bytes, info, spec, { ...limits, ...overrides });
}

async function pixels(bytes: Uint8Array): Promise<(x: number, y: number) => number[]> {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  return (x, y) => {
    const offset = (y * info.width + x) * info.channels;
    return [...data.subarray(offset, offset + info.channels)];
  };
}

const quadrants = (width: number, height: number) =>
  generateImage({ width, height, format: 'png', pattern: 'quadrants' });

describe('transform crop modes on a 400 by 200 source into a 100 by 100 box', () => {
  it('fit keeps the aspect ratio inside the box', async () => {
    const result = await run(await quadrants(400, 200), { width: 100, height: 100, crop: 'fit' });
    expect([result.width, result.height]).toEqual([100, 50]);
  });

  it('fill covers the box and crops the overflow from the center', async () => {
    const result = await run(await quadrants(400, 200), { width: 100, height: 100, crop: 'fill' });
    const at = await pixels(result.bytes);
    expect([result.width, result.height]).toEqual([100, 100]);
    expect([at(25, 25), at(75, 25), at(25, 75), at(75, 75)]).toEqual([RED, GREEN, BLUE, YELLOW]);
  });

  it('scale stretches to exactly the box', async () => {
    const result = await run(await quadrants(400, 200), { width: 100, height: 100, crop: 'scale' });
    const at = await pixels(result.bytes);
    expect([result.width, result.height]).toEqual([100, 100]);
    expect([at(0, 0), at(99, 0), at(0, 99), at(99, 99)]).toEqual([RED, GREEN, BLUE, YELLOW]);
  });

  it('pad fits inside the box and pads the remainder', async () => {
    const result = await run(await quadrants(400, 200), { width: 100, height: 100, crop: 'pad' });
    const at = await pixels(result.bytes);
    expect([result.width, result.height]).toEqual([100, 100]);
    expect([at(25, 40), at(75, 60)]).toEqual([
      [...RED, 255],
      [...YELLOW, 255],
    ]);
  });
});

describe('transform resizing', () => {
  it('fit never enlarges', async () => {
    const result = await run(await quadrants(100, 50), { width: 400, crop: 'fit' });
    expect([result.width, result.height]).toEqual([100, 50]);
  });

  for (const crop of ['fill', 'scale', 'pad'] as const) {
    it(`${crop} enlarges to the requested box`, async () => {
      const result = await run(await quadrants(100, 50), { width: 400, height: 400, crop });
      expect([result.width, result.height]).toEqual([400, 400]);
    });
  }

  it('fill crops the sides of a wide source where scale keeps them', async () => {
    // Quadrants look the same cropped or stretched, so the source first gets transparent sides.
    const padded = await run(await quadrants(400, 200), {
      width: 800,
      height: 200,
      crop: 'pad',
    });
    const source = { bytes: padded.bytes, format: padded.format };
    const filled = await pixels(
      (await run(source, { width: 100, height: 100, crop: 'fill' })).bytes,
    );
    const scaled = await pixels(
      (await run(source, { width: 100, height: 100, crop: 'scale' })).bytes,
    );
    expect([filled(2, 50)[3], scaled(2, 50)[3]]).toEqual([255, 0]);
  });

  it('scales to one dimension preserving the aspect ratio', async () => {
    const result = await run(await quadrants(400, 200), { width: 200 });
    expect([result.width, result.height]).toEqual([200, 100]);
  });

  it('pads with transparency for an output with alpha and with white for jpeg', async () => {
    const source = await quadrants(400, 200);
    const png = await pixels((await run(source, { width: 100, height: 100, crop: 'pad' })).bytes);
    const jpeg = await pixels(
      (await run(source, { width: 100, height: 100, crop: 'pad', format: 'jpeg' })).bytes,
    );
    expect([png(0, 0)[3], png(99, 99)[3]]).toEqual([0, 0]);
    for (const corner of [jpeg(0, 0), jpeg(99, 99)]) {
      expect(Math.min(...corner)).toBeGreaterThanOrEqual(250);
    }
  });
});

describe('transform orientation', () => {
  it('applies the EXIF orientation and strips the tag', async () => {
    const source = await generateImage({
      width: 400,
      height: 200,
      format: 'png',
      pattern: 'quadrants',
      orientation: 6,
    });
    const info = await inspect(source.bytes, source.format);
    const result = await run(source, {});
    const at = await pixels(result.bytes);
    const metadata = await sharp(result.bytes).metadata();
    expect([info.width, info.height]).toEqual([200, 400]);
    expect([result.width, result.height]).toEqual([200, 400]);
    expect([at(50, 100), at(150, 100), at(50, 300), at(150, 300)]).toEqual([
      BLUE,
      RED,
      YELLOW,
      GREEN,
    ]);
    expect([metadata.orientation, metadata.exif]).toEqual([undefined, undefined]);
  });
});

describe('transform output formats', () => {
  const outputs: { format: OutputFormat; decoder: string }[] = [
    { format: 'jpeg', decoder: 'jpeg' },
    { format: 'png', decoder: 'png' },
    { format: 'webp', decoder: 'webp' },
    { format: 'avif', decoder: 'heif' },
  ];
  for (const { format, decoder } of outputs) {
    it(`encodes ${format} that round-trips through inspect`, async () => {
      const result = await run(await quadrants(400, 200), { width: 100, format });
      expect([result.format, result.contentType]).toEqual([format, `image/${format}`]);
      expect(await inspect(result.bytes, format)).toEqual({
        format,
        width: 100,
        height: 50,
        pages: 1,
      });
      expect((await sharp(result.bytes).metadata()).format).toBe(decoder);
    });
  }

  const sources: { source: SourceType; output: OutputFormat; decoder: string }[] = [
    { source: 'jpeg', output: 'jpeg', decoder: 'jpeg' },
    { source: 'png', output: 'png', decoder: 'png' },
    { source: 'webp', output: 'webp', decoder: 'webp' },
    { source: 'avif', output: 'avif', decoder: 'heif' },
    { source: 'tiff', output: 'png', decoder: 'png' },
    { source: 'gif', output: 'png', decoder: 'png' },
  ];
  for (const { source, output, decoder } of sources) {
    it(`keeps a ${source} source as ${output} when the format is source`, async () => {
      const image = await generateImage({ width: 40, height: 20, format: source });
      const result = await run(image, {});
      expect(result.format).toBe(output);
      expect((await sharp(result.bytes).metadata()).format).toBe(decoder);
    });
  }
});

describe('transform quality', () => {
  for (const format of ['jpeg', 'webp', 'avif'] as const) {
    it(`produces a smaller ${format} at quality 10 than at 90`, async () => {
      const source = await generateImage({
        width: 128,
        height: 128,
        format: 'png',
        pattern: 'noise',
      });
      const low = await run(source, { format, quality: 10 });
      const high = await run(source, { format, quality: 90 });
      expect(low.bytes.byteLength).toBeLessThan(high.bytes.byteLength);
    });
  }

  // The spec carries no quality for format=png, but does for format=source, so only the
  // second case shows the encoder ignoring a quality it is given.
  for (const format of ['png', undefined] as const) {
    it(`ignores quality for png output ${format === undefined ? 'resolved from the source' : 'requested as png'}`, async () => {
      // A quality reaching the PNG encoder changes the bytes for resampled half-transparent
      // noise; with fewer colors or no alpha the quantized palette can come out identical.
      const source = await generateImage({
        width: 128,
        height: 128,
        format: 'png',
        pattern: 'noise',
        alpha: true,
      });
      const low = await run(source, { width: 64, ...(format && { format }), quality: 10 });
      const high = await run(source, { width: 64, ...(format && { format }), quality: 90 });
      expect(low.format).toBe('png');
      expect(low.bytes).toEqual(high.bytes);
    });
  }
});

describe('transform limits', () => {
  it('refuses a png output above the byte cap and accepts the same as jpeg', async () => {
    const source = await generateImage({
      width: 128,
      height: 128,
      format: 'png',
      pattern: 'noise',
    });
    // Noise does not compress, so its PNG exceeds the raw pixel bytes; a JPEG stays well under.
    const cap = { maxOutputBytes: 128 * 128 * 3 };
    await expect(run(source, { format: 'png' }, cap)).rejects.toMatchObject({
      code: 'output_too_large',
    });
    const jpeg = await run(source, { format: 'jpeg' }, cap);
    expect(jpeg.bytes.byteLength).toBeLessThanOrEqual(cap.maxOutputBytes);
  });

  it('reads the dimensions of a source above the pixel limit, and refuses to transform it', async () => {
    const source = await quadrants(400, 200);
    const info = await inspect(source.bytes, source.format);
    const spec = toSpec({ url: 'https://images.example/source' }, { quality: 80 });
    expect(info).toEqual({ format: 'png', width: 400, height: 200, pages: 1 });
    await expect(
      transform(source.bytes, info, spec, { ...limits, maxInputPixels: 10_000 }),
    ).rejects.toMatchObject({ code: 'source_too_large' });
  });
});

describe('inspect', () => {
  it('refuses a header sharp cannot parse', async () => {
    const source = await generateImage({ width: 40, height: 20, format: 'jpeg' });
    await expect(inspect(source.bytes.subarray(0, 16), 'jpeg')).rejects.toMatchObject({
      code: 'unsupported_source_type',
    });
  });
});

describe('fromSharpError', () => {
  const cases: { name: string; error: unknown; code: ServiceError['code'] }[] = [
    { name: 'a bare timeout', error: new Error('timeout: 0% complete'), code: 'transform_timeout' },
    {
      name: 'a timeout followed by the libvips kill notice',
      error: new Error('timeout: 43% complete\nVipsImage: killed for image "temp-97"'),
      code: 'transform_timeout',
    },
    {
      name: 'the pixel limit',
      error: new Error('Input image exceeds pixel limit'),
      code: 'source_too_large',
    },
    {
      name: 'any other sharp error',
      error: new Error('Input buffer contains unsupported image format'),
      code: 'internal_error',
    },
    {
      name: 'a timeout mentioned mid-message',
      error: new Error('vips2png: timeout: 5% complete'),
      code: 'internal_error',
    },
    { name: 'a thrown non-error', error: 'timeout: 5% complete', code: 'internal_error' },
  ];
  for (const c of cases) {
    it(`maps ${c.name} to ${c.code} and keeps it as the cause`, () => {
      const mapped = fromSharpError(c.error);
      expect(mapped).toBeInstanceOf(ServiceError);
      expect([mapped.code, mapped.cause]).toEqual([c.code, c.error]);
    });
  }
});

describe('pipelineVersion', () => {
  it('combines the sharp version with the pipeline revision', () => {
    expect(pipelineVersion()).toBe(`${sharp.versions.sharp}/${PIPELINE_REVISION}`);
  });
});
