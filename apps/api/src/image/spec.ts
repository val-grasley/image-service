import type { CropMode, OutputFormat, ProcessParams } from '@image-service/sdk';

export type TransformSpec = {
  url: URL;
  width: number | undefined;
  height: number | undefined;
  crop: CropMode;
  format: OutputFormat | 'source';
  quality: number;
};

export function toSpec(params: ProcessParams, defaults: { quality: number }): TransformSpec {
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
