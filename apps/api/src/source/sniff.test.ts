import type { SourceType } from '@image-service/sdk';
import { generateImage } from '@image-service/fake-upstream/generator';
import { describe, expect, it } from 'vitest';
import { sniff } from './sniff.ts';

const SOURCE_TYPES: SourceType[] = ['jpeg', 'png', 'webp', 'gif', 'avif', 'tiff'];

async function generated(format: SourceType): Promise<Uint8Array> {
  const image = await generateImage({ width: 8, height: 8, format });
  return image.bytes;
}

function withBytes(bytes: Uint8Array, offset: number, replacement: number[]): Uint8Array {
  const copy = Uint8Array.from(bytes);
  copy.set(replacement, offset);
  return copy;
}

const text = (markup: string): Uint8Array => new TextEncoder().encode(markup);

describe('sniff', () => {
  for (const format of SOURCE_TYPES) {
    it(`recognizes a generated ${format}`, async () => {
      expect(sniff(await generated(format))).toBe(format);
    });
  }

  it('recognizes a GIF87a header', async () => {
    expect(sniff(withBytes(await generated('gif'), 4, [0x37]))).toBe('gif');
  });

  it('recognizes a big-endian TIFF header', async () => {
    expect(sniff(withBytes(await generated('tiff'), 0, [0x4d, 0x4d, 0x00, 0x2a]))).toBe('tiff');
  });

  it('recognizes the avis brand as AVIF', async () => {
    expect(sniff(withBytes(await generated('avif'), 8, [0x61, 0x76, 0x69, 0x73]))).toBe('avif');
  });

  it('rejects a GIF signature with an unknown version', async () => {
    expect(sniff(withBytes(await generated('gif'), 4, [0x38]))).toBeUndefined();
  });

  it('rejects a RIFF container that is not WebP', async () => {
    expect(sniff(withBytes(await generated('webp'), 8, [0x57, 0x41, 0x56, 0x45]))).toBeUndefined();
  });

  it('rejects an ftyp box with a brand other than AVIF', async () => {
    expect(sniff(withBytes(await generated('avif'), 8, [0x68, 0x65, 0x69, 0x63]))).toBeUndefined();
  });

  it('rejects SVG', () => {
    expect(sniff(text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
  });

  it('rejects HTML', () => {
    expect(sniff(text('<!doctype html><title>Not an image</title>'))).toBeUndefined();
  });

  it('rejects an empty buffer', () => {
    expect(sniff(new Uint8Array())).toBeUndefined();
  });

  it('rejects a three-byte buffer', async () => {
    expect(sniff((await generated('png')).subarray(0, 3))).toBeUndefined();
  });

  it('rejects a PNG signature with its last byte altered', async () => {
    expect(sniff(withBytes(await generated('png'), 7, [0x0b]))).toBeUndefined();
  });
});
