import { randomBytes } from 'node:crypto';
import type { SourceType } from '@image-service/sdk';
import sharp from 'sharp';

export const PATTERNS = ['solid', 'quadrants', 'noise'] as const;
export const ORIENTATIONS = [1, 3, 6, 8] as const;

export type ImageSpec = {
  width: number;
  height: number;
  format: SourceType;
  pattern?: (typeof PATTERNS)[number];
  orientation?: (typeof ORIENTATIONS)[number];
  alpha?: boolean;
};

type GeneratedImage = { bytes: Uint8Array; width: number; height: number; format: SourceType };

type Rgb = readonly [number, number, number];
type Raster = { pixels: Buffer; channels: 3 | 4 };

const SOLID: Rgb = [64, 128, 192];
const QUADRANTS: readonly [Rgb, Rgb, Rgb, Rgb] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
];
// Half-transparent, so both the presence of alpha and flattening onto a background show.
const ALPHA = 128;

const generated = new Map<string, Promise<GeneratedImage>>();

export function generateImage(spec: ImageSpec): Promise<GeneratedImage> {
  const key = [
    spec.width,
    spec.height,
    spec.format,
    spec.pattern ?? 'solid',
    spec.orientation,
    spec.alpha ?? false,
  ].join(':');
  let image = generated.get(key);
  if (image === undefined) {
    image = encode(spec);
    generated.set(key, image);
  }
  return image;
}

function paint(
  width: number,
  height: number,
  pattern: (typeof PATTERNS)[number],
  channels: 3 | 4,
): Raster {
  const size = width * height * channels;
  const pixels = pattern === 'noise' ? randomBytes(size) : Buffer.alloc(size);
  const [topLeft, topRight, bottomLeft, bottomRight] = QUADRANTS;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      if (pattern === 'solid') pixels.set(SOLID, offset);
      if (pattern === 'quadrants') {
        const left = x < width / 2;
        const top = y < height / 2;
        pixels.set(top ? (left ? topLeft : topRight) : left ? bottomLeft : bottomRight, offset);
      }
      if (channels === 4) pixels[offset + 3] = ALPHA;
    }
  }
  return { pixels, channels };
}

async function encode(spec: ImageSpec): Promise<GeneratedImage> {
  // Refused rather than encoded, so no fixture lacks what its spec claims (decision 36).
  if (spec.orientation !== undefined && (spec.format === 'gif' || spec.format === 'avif')) {
    throw new RangeError(`${spec.format} cannot carry an EXIF orientation tag`);
  }
  if (
    spec.alpha === true &&
    (spec.format === 'jpeg' || spec.format === 'tiff' || spec.format === 'gif')
  ) {
    throw new RangeError(`${spec.format} cannot carry a half-transparent alpha channel`);
  }
  const { pixels, channels } = paint(
    spec.width,
    spec.height,
    spec.pattern ?? 'solid',
    spec.alpha === true ? 4 : 3,
  );
  let image = sharp(pixels, { raw: { width: spec.width, height: spec.height, channels } });
  if (spec.orientation !== undefined) {
    image = image.withMetadata({ orientation: spec.orientation });
  }
  const bytes = await image.toFormat(spec.format).toBuffer();
  return { bytes, width: spec.width, height: spec.height, format: spec.format };
}
