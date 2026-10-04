import type { CropMode, OutputFormat, SourceInfo, SourceType } from '@image-service/sdk';
import sharp, { type ResizeOptions, type Sharp } from 'sharp';
import type { Config } from '../config.ts';
import { ServiceError } from '../errors.ts';
import type { TransformSpec } from './spec.ts';

type InspectResult = Pick<SourceInfo, 'format' | 'width' | 'height' | 'pages'>;

export type TransformResult = {
  bytes: Uint8Array;
  format: OutputFormat;
  contentType: string;
  width: number;
  height: number;
};

type PipelineLimits = Pick<Config, 'maxInputPixels' | 'transformTimeoutSeconds' | 'maxOutputBytes'>;

export const PIPELINE_REVISION = '1';

export function pipelineVersion(): string {
  return `${sharp.versions.sharp}/${PIPELINE_REVISION}`;
}

const SOURCE_OUTPUT: Record<SourceType, OutputFormat> = {
  jpeg: 'jpeg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  tiff: 'png',
  // GIF output would re-quantize the first frame with no benefit over PNG.
  gif: 'png',
};

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

// libvips appends its own lines after the first, so only the first line is matched.
const TIMEOUT_MESSAGE = /^timeout: \d+% complete(?:\n|$)/;
const PIXEL_LIMIT_MESSAGE = 'Input image exceeds pixel limit';

export async function inspect(bytes: Uint8Array, type: SourceType): Promise<InspectResult> {
  // The pixel limit is enforced when the input is opened; the operation compares the
  // dimensions itself, so they must be readable from an oversized header.
  const metadata = await sharp(bytes, { limitInputPixels: false })
    .metadata()
    .catch((error: unknown) => {
      throw new ServiceError(
        'unsupported_source_type',
        'The source image header could not be read.',
        {},
        { cause: error },
      );
    });
  return {
    format: type,
    width: metadata.autoOrient.width,
    height: metadata.autoOrient.height,
    pages: metadata.pages ?? 1,
  };
}

export async function transform(
  bytes: Uint8Array,
  info: InspectResult,
  spec: TransformSpec,
  limits: PipelineLimits,
): Promise<TransformResult> {
  const format = spec.format === 'source' ? SOURCE_OUTPUT[info.format] : spec.format;
  let image = sharp(bytes, { limitInputPixels: limits.maxInputPixels })
    .timeout({ seconds: limits.transformTimeoutSeconds })
    .autoOrient();
  if (spec.width !== undefined || spec.height !== undefined) {
    image = image.resize(spec.width, spec.height, resizeOptions(spec.crop, format));
  }
  const output = await encode(image, format, spec.quality)
    .toBuffer({ resolveWithObject: true })
    .catch((error: unknown) => {
      throw fromSharpError(error);
    });
  if (output.data.byteLength > limits.maxOutputBytes) {
    throw new ServiceError(
      'output_too_large',
      `The encoded image exceeds ${String(limits.maxOutputBytes)} bytes; request smaller dimensions or a lossy format.`,
    );
  }
  return {
    bytes: output.data,
    format,
    contentType: `image/${format}`,
    width: output.info.width,
    height: output.info.height,
  };
}

function resizeOptions(crop: CropMode, format: OutputFormat): ResizeOptions {
  switch (crop) {
    case 'fit':
      return { fit: 'inside', withoutEnlargement: true };
    case 'fill':
      return { fit: 'cover', withoutEnlargement: false };
    case 'scale':
      return { fit: 'fill', withoutEnlargement: false };
    case 'pad':
      // JPEG is the only output format without an alpha channel.
      return {
        fit: 'contain',
        withoutEnlargement: false,
        background: format === 'jpeg' ? WHITE : TRANSPARENT,
      };
  }
}

function encode(image: Sharp, format: OutputFormat, quality: number): Sharp {
  switch (format) {
    case 'jpeg':
      return image.jpeg({ quality, mozjpeg: true });
    case 'png':
      // Passing quality to the PNG encoder would switch it to palette quantization.
      return image.png();
    case 'webp':
      return image.webp({ quality });
    case 'avif':
      return image.avif({ quality, effort: 2 });
  }
}

export function fromSharpError(error: unknown): ServiceError {
  const message = error instanceof Error ? error.message : '';
  const options = { cause: error };
  if (TIMEOUT_MESSAGE.test(message)) {
    return new ServiceError(
      'transform_timeout',
      'The transform exceeded its time budget.',
      {},
      options,
    );
  }
  if (message === PIXEL_LIMIT_MESSAGE) {
    return new ServiceError(
      'source_too_large',
      'The source image has more pixels than the service accepts.',
      {},
      options,
    );
  }
  return new ServiceError('internal_error', 'The image could not be processed.', {}, options);
}
