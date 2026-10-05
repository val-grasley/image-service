import type { CropMode, OutputFormat, ProcessParams, SourceType } from '@image-service/sdk';

// PNG is lossless, so a quality would only split the cache and the ETag over identical bytes.
export type Encoding =
  { format: 'png' } | { format: Exclude<OutputFormat, 'png'>; quality: number };

// `source` keeps its quality because the source may resolve to a lossy format.
export type TransformSpec = {
  url: URL;
  width: number | undefined;
  height: number | undefined;
  crop: CropMode;
} & (Encoding | { format: 'source'; quality: number });

const SOURCE_OUTPUT: Record<SourceType, OutputFormat> = {
  jpeg: 'jpeg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  tiff: 'png',
  // GIF output would re-quantize the first frame with no benefit over PNG.
  gif: 'png',
};

// Zod types an omitted optional field as `T | undefined`, which exactOptionalPropertyTypes keeps
// apart from ProcessParams' absent key; toSpec treats the two alike.
type ValidatedParams = {
  [K in keyof ProcessParams]: undefined extends ProcessParams[K]
    ? ProcessParams[K] | undefined
    : ProcessParams[K];
};

export function toSpec(params: ValidatedParams, defaults: { quality: number }): TransformSpec {
  const common = {
    url: new URL(params.url),
    width: params.width,
    height: params.height,
    crop: params.crop ?? 'fit',
  };
  const format = params.format ?? 'source';
  return format === 'png'
    ? { ...common, format }
    : { ...common, format, quality: params.quality ?? defaults.quality };
}

export function cacheKey(spec: TransformSpec): string {
  return [
    'v1',
    `url=${spec.url.href}`,
    `w=${String(spec.width ?? '-')}`,
    `h=${String(spec.height ?? '-')}`,
    `crop=${spec.crop}`,
    `format=${spec.format}`,
    `q=${spec.format === 'png' ? '-' : String(spec.quality)}`,
  ].join('|');
}

export function resolveEncoding(spec: TransformSpec, source: SourceType): Encoding {
  if (spec.format === 'png') {
    return { format: 'png' };
  }
  const format = spec.format === 'source' ? SOURCE_OUTPUT[source] : spec.format;
  return format === 'png' ? { format } : { format, quality: spec.quality };
}
