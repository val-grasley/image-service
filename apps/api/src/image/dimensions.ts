import type { TransformSpec } from './spec.ts';

type Dimensions = { width: number; height: number };

// Mirrors sharp's resize arithmetic (ResolveShrink in its common.cc), so a cap on the output
// can be checked before any pixel is decoded.
export function outputDimensions(
  source: Dimensions,
  { width, height, crop }: Pick<TransformSpec, 'width' | 'height' | 'crop'>,
): Dimensions {
  const widthShrink = width === undefined ? undefined : source.width / width;
  const heightShrink = height === undefined ? undefined : source.height / height;
  switch (crop) {
    case 'fit':
      return scaled(source, Math.max(1, widthShrink ?? 1, heightShrink ?? 1));
    case 'fill':
    case 'pad':
      return width !== undefined && height !== undefined
        ? { width, height }
        : scaled(source, widthShrink ?? heightShrink ?? 1);
    case 'scale':
      // sharp ignores the aspect ratio here, so an omitted dimension stays the source's.
      return { width: width ?? source.width, height: height ?? source.height };
  }
}

function scaled(source: Dimensions, shrink: number): Dimensions {
  // sharp never shrinks an axis below one pixel.
  return {
    width: Math.round(source.width / Math.min(shrink, source.width)),
    height: Math.round(source.height / Math.min(shrink, source.height)),
  };
}
