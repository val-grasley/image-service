/** Every crop mode `/process` accepts, in the order the documentation lists them. */
export const CROP_MODES = ['fit', 'fill', 'scale', 'pad'] as const;

/**
 * How the source is fitted to the requested box. `fit` keeps the aspect ratio inside the box
 * and never enlarges; `fill` covers the box and crops the overflow; `scale` stretches to the
 * exact box; `pad` fits inside the box and pads the remainder.
 */
export type CropMode = (typeof CROP_MODES)[number];

/** Every output format `/process` can encode. */
export const OUTPUT_FORMATS = ['jpeg', 'png', 'webp', 'avif'] as const;

/** An encoding `/process` can produce. When omitted, the service keeps the source format. */
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** The query parameters of `GET /process`. Ranges are validated by the service, not here. */
export type ProcessParams = {
  /** Absolute `http` or `https` URL of the source image. */
  url: string;
  /** Output width in pixels. Omit one of `width` and `height` to keep the aspect ratio. */
  width?: number;
  /** Output height in pixels. */
  height?: number;
  /** Defaults to `fit` on the service. */
  crop?: CropMode;
  /** Defaults to the source format on the service (`png` for TIFF and GIF sources). */
  format?: OutputFormat;
  /** Lossy encoder quality from 1 to 100; ignored for PNG. */
  quality?: number;
};

/**
 * Builds the canonical `/process` URL. Parameters are emitted in the fixed order `url, width,
 * height, crop, format, quality`, absent ones are omitted, and no defaults are added, so equal
 * parameters always give byte-identical URLs and share CDN cache entries. The path `/process`
 * replaces any path on `baseUrl`.
 */
export function processUrl(baseUrl: string | URL, params: ProcessParams): URL {
  const url = new URL('/process', baseUrl);
  url.searchParams.set('url', params.url);
  if (params.width !== undefined) url.searchParams.set('width', String(params.width));
  if (params.height !== undefined) url.searchParams.set('height', String(params.height));
  if (params.crop !== undefined) url.searchParams.set('crop', params.crop);
  if (params.format !== undefined) url.searchParams.set('format', params.format);
  if (params.quality !== undefined) url.searchParams.set('quality', String(params.quality));
  return url;
}

/** Builds the `/info` URL for a source image. The path `/info` replaces any path on `baseUrl`. */
export function infoUrl(baseUrl: string | URL, sourceUrl: string): URL {
  const url = new URL('/info', baseUrl);
  url.searchParams.set('url', sourceUrl);
  return url;
}

/**
 * Returns a shell command that fetches `url` with curl, prints the response headers, and saves
 * the body to `out.<format>`, or to `out` when the URL names no known output format. The URL
 * is single-quoted with any single quote escaped.
 */
export function curlFor(url: URL): string {
  const requested = url.searchParams.get('format');
  // The extension lands unquoted in the shell line, so only a known format may supply it.
  const format = OUTPUT_FORMATS.find((candidate) => candidate === requested);
  const output = format === undefined ? 'out' : `out.${format}`;
  return `curl -sS -D - -o ${output} '${url.href.replaceAll("'", "'\\''")}'`;
}
