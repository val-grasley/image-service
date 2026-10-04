import type { CropMode, OutputFormat, ProcessParams } from '@image-service/sdk';

export type TransformSpec = {
  url: URL;
  width: number | undefined;
  height: number | undefined;
  crop: CropMode;
  format: OutputFormat | 'source';
  quality: number;
};

// Zod types an omitted optional field as `T | undefined`, which exactOptionalPropertyTypes keeps
// apart from ProcessParams' absent key; toSpec treats the two alike.
type ValidatedParams = {
  [K in keyof ProcessParams]: undefined extends ProcessParams[K]
    ? ProcessParams[K] | undefined
    : ProcessParams[K];
};

export function toSpec(params: ValidatedParams, defaults: { quality: number }): TransformSpec {
  return {
    url: new URL(params.url),
    width: params.width,
    height: params.height,
    crop: params.crop ?? 'fit',
    format: params.format ?? 'source',
    quality: params.quality ?? defaults.quality,
  };
}

export function cacheKey(spec: TransformSpec): string {
  return [
    'v1',
    `url=${spec.url.href}`,
    `w=${String(spec.width ?? '-')}`,
    `h=${String(spec.height ?? '-')}`,
    `crop=${spec.crop}`,
    `format=${spec.format}`,
    `q=${String(spec.quality)}`,
  ].join('|');
}
