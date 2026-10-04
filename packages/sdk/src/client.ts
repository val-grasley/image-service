/** A source image type the service accepts and `/info` reports. */
export type SourceType = 'jpeg' | 'png' | 'webp' | 'gif' | 'avif' | 'tiff';

/** The `GET /info` response: metadata of the source image, read without transforming it. */
export type SourceInfo = {
  /** The URL as requested. */
  url: string;
  /** The URL after redirects. */
  finalUrl: string;
  /** The type detected from the bytes; the upstream `Content-Type` is not trusted. */
  format: SourceType;
  /** Width in pixels after EXIF orientation. */
  width: number;
  /** Height in pixels after EXIF orientation. */
  height: number;
  /** Size of the source in bytes. */
  bytes: number;
  /** Frame or page count; `/process` uses the first. */
  pages: number;
};
