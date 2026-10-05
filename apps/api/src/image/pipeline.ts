import type { OutputFormat, SourceInfo, SourceType } from '@image-service/sdk';
import sharp, { type ResizeOptions, type Sharp } from 'sharp';
import type { Config } from '../config.ts';
import { ServiceError } from '../errors.ts';
import { outputDimensions } from './dimensions.ts';
import { resolveEncoding, type Encoding, type TransformSpec } from './spec.ts';

export type InspectResult = Pick<SourceInfo, 'format' | 'width' | 'height' | 'pages'>;

export type TransformResult = {
  bytes: Uint8Array;
  format: OutputFormat;
  contentType: string;
  width: number;
  height: number;
};

type PipelineLimits = Pick<
  Config,
  'maxInputPixels' | 'transformTimeoutSeconds' | 'maxOutputBytes' | 'maxAvifOutputPixels'
>;

export const PIPELINE_REVISION = '4';

export function pipelineVersion(): string {
  return `${sharp.versions.sharp}/${PIPELINE_REVISION}`;
}

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

// libvips appends its own lines after the first, so only the first line is matched.
const TIMEOUT_MESSAGE = /^timeout: \d+% complete(?:\n|$)/;
const PIXEL_LIMIT_MESSAGE = 'Input image exceeds pixel limit';
// libvips starts each error with the domain that raised it. These are the loaders of five of
// the six accepted types (AVIF's `heif` may also come from its saver; a damaged AVIF reports
// `source` first) and libvips's input source, plus sharp's own line for a loader warning that
// failOn escalated, so a match means the source failed to decode (decision 66).
const DECODE_MESSAGE =
  /^(?:(?:VipsJpeg|vipspng|webp2vips|gifload_buffer|tiff2vips|source): |Warning treated as error due to failOn setting(?:\n|$))/;

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
  const target = resolveEncoding(spec, info.format);
  const { format } = target;
  if (format === 'avif') {
    // sharp's timeout cannot interrupt the AVIF encoder, so its time is bounded by pixel count.
    const { width, height } = outputDimensions(info, spec);
    const pixels = width * height;
    if (pixels > limits.maxAvifOutputPixels) {
      throw new ServiceError(
        'output_too_large',
        `The AVIF output would be ${String(width)} by ${String(height)} (${String(pixels)} pixels); MAX_AVIF_OUTPUT_PIXELS allows at most ${String(limits.maxAvifOutputPixels)}; request smaller dimensions or another format.`,
      );
    }
  }
  let warned = false;
  let image = sharp(bytes, { limitInputPixels: limits.maxInputPixels })
    .timeout({ seconds: limits.transformTimeoutSeconds })
    .autoOrient();
  // When failOn escalates a loader warning and an encoder error then replaces sharp's own line,
  // the warning event, emitted before the rejection, is the only sign the decode failed.
  image.on('warning', () => {
    warned = true;
  });
  if (format === 'jpeg') {
    // The JPEG encoder drops alpha, which would leave transparent pixels their stored color,
    // usually black.
    image = image.flatten({ background: WHITE });
  }
  if (spec.width !== undefined || spec.height !== undefined) {
    image = image.resize(spec.width, spec.height, resizeOptions(spec, format));
  }
  const output = await encode(image, target)
    .toBuffer({ resolveWithObject: true })
    .catch((error: unknown) => {
      throw fromSharpError(error, warned);
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

function resizeOptions(
  { crop, width, height }: Pick<TransformSpec, 'crop' | 'width' | 'height'>,
  format: OutputFormat,
): ResizeOptions {
  switch (crop) {
    case 'fit':
      return { fit: 'inside', withoutEnlargement: true };
    case 'fill':
      return { fit: 'cover', withoutEnlargement: false };
    case 'scale':
      // sharp's fill ignores the aspect ratio even for an omitted dimension, which it would
      // keep at the source's; inside derives it from the one given.
      return width !== undefined && height !== undefined
        ? { fit: 'fill', withoutEnlargement: false }
        : { fit: 'inside', withoutEnlargement: false };
    case 'pad':
      // JPEG is the only output format without an alpha channel.
      return {
        fit: 'contain',
        withoutEnlargement: false,
        background: format === 'jpeg' ? WHITE : TRANSPARENT,
      };
  }
}

function encode(image: Sharp, target: Encoding): Sharp {
  switch (target.format) {
    case 'jpeg':
      // mozjpeg's encoder is not interrupted by sharp's timeout; plain libjpeg is fast enough.
      return image.jpeg({ quality: target.quality });
    case 'png':
      // Passing quality to the PNG encoder would switch it to palette quantization.
      return image.png();
    case 'webp':
      return image.webp({ quality: target.quality });
    case 'avif':
      return image.avif({ quality: target.quality, effort: 0 });
  }
}

export function fromSharpError(error: unknown, warned: boolean): ServiceError {
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
  if (DECODE_MESSAGE.test(message) || warned) {
    return new ServiceError(
      'unsupported_source_type',
      'The source image could not be decoded; it may be truncated or corrupt.',
      {},
      options,
    );
  }
  return new ServiceError('internal_error', 'The image could not be processed.', {}, options);
}
