import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { OUTPUT_FORMATS } from '@image-service/sdk';
import type { Config } from '../../config.ts';
import { toSpec } from '../../image/spec.ts';
import type { OperationDeps } from '../../operations/deps.ts';
import { processImage } from '../../operations/process-image.ts';
import type { AppEnv } from '../context.ts';
import { commonHeaders, header, problemResponses } from '../openapi.ts';

export const sourceUrlParam = z.url({ error: 'must be an absolute URL' }).openapi({
  description: 'Absolute http or https URL of the source image.',
  example: 'https://images.example/photo.jpg',
});

// Strict, because an ignored misspelling returns an untransformed image with a 200 and every
// extra parameter mints another CDN cache key (decision 61).
export function strictQuery<Shape extends z.core.$ZodLooseShape>(
  shape: Shape,
): z.ZodObject<z.core.util.Writeable<Shape>, z.core.$strict> {
  return z.strictObject(shape, { error: `not accepted; use ${Object.keys(shape).join(', ')}` });
}

function integer(min: number, max: number) {
  const error = `must be an integer between ${String(min)} and ${String(max)}`;
  return z.coerce
    .number({ error })
    .int({ error })
    .min(min, { error })
    .max(max, { error })
    .optional();
}

function processQuery(
  config: Pick<Config, 'maxOutputDimension' | 'maxOutputPixels' | 'defaultQuality'>,
) {
  const maxPixels = config.maxOutputPixels;
  return strictQuery({
    url: sourceUrlParam,
    width: integer(1, config.maxOutputDimension).openapi({
      description: 'Output width in pixels. Omit width or height to keep the aspect ratio.',
    }),
    height: integer(1, config.maxOutputDimension).openapi({
      description: 'Output height in pixels. Omit width or height to keep the aspect ratio.',
    }),
    crop: z
      .enum(['fit', 'fill', 'scale', 'pad'], { error: 'must be one of fit, fill, scale, pad' })
      .optional()
      .openapi({
        description:
          'How the source fits the box: fit stays inside it and never enlarges; fill covers it and crops; scale stretches to it; pad fits inside it and pads.',
        default: 'fit',
      }),
    format: z
      .enum(['jpeg', 'png', 'webp', 'avif'], { error: 'must be one of jpeg, png, webp, avif' })
      .optional()
      .openapi({
        description: 'Output encoding. Defaults to the source format, or png for TIFF and GIF.',
      }),
    quality: integer(1, 100).openapi({
      description: 'Lossy encoder quality; ignored for png.',
      default: config.defaultQuality,
    }),
  }).refine(
    ({ width, height }) =>
      width === undefined || height === undefined || width * height <= maxPixels,
    {
      error: `width times height must be at most ${String(maxPixels)} pixels`,
      path: ['width'],
    },
  );
}

export type ProcessQuery = z.output<ReturnType<typeof processQuery>>;

const BINARY = { schema: z.string().openapi({ format: 'binary' }) };

const ETAG = header('Strong validator of this result; send it in If-None-Match to revalidate.');

export function addProcessRoute(
  app: OpenAPIHono<AppEnv>,
  config: Config,
  deps: OperationDeps,
): void {
  const cacheControl = `public, max-age=${String(config.resultCacheTtlSeconds)}`;
  const route = createRoute({
    method: 'get',
    path: '/process',
    summary: 'Fetch an image, resize it, and re-encode it',
    request: { query: processQuery(config) },
    responses: {
      200: {
        description: 'The transformed image.',
        headers: {
          ...commonHeaders(cacheControl),
          ETag: ETAG,
          'Content-Length': header(
            'Size of the image in bytes. A streamed response may arrive chunked without it, so measure the body.',
            { type: 'integer' },
            false,
          ),
          'X-Image-Width': header('Width of the image in pixels.', { type: 'integer' }),
          'X-Image-Height': header('Height of the image in pixels.', { type: 'integer' }),
          'X-Image-Format': header('Encoding of the image.', {
            type: 'string',
            enum: [...OUTPUT_FORMATS],
          }),
          'X-Result-Cache': header(
            "Whether this instance's in-process result cache answered; says nothing about the CDN.",
            { type: 'string', enum: ['hit', 'miss'] },
          ),
          'X-Content-Type-Options': header('Browsers must not sniff the type.', {
            type: 'string',
            const: 'nosniff',
          }),
          'Content-Disposition': header('Display the image rather than download it.', {
            type: 'string',
            const: 'inline',
          }),
        },
        content: {
          'image/jpeg': BINARY,
          'image/png': BINARY,
          'image/webp': BINARY,
          'image/avif': BINARY,
        },
      },
      304: {
        description: 'The image named by If-None-Match is unchanged.',
        headers: { ...commonHeaders(cacheControl), ETag: ETAG },
      },
      ...problemResponses([
        'invalid_parameter',
        'url_not_allowed',
        'source_too_large',
        'unsupported_source_type',
        'output_too_large',
        'rate_limited',
        'internal_error',
        'transform_timeout',
        'upstream_error',
        'too_many_redirects',
        'upstream_timeout',
      ]),
    },
  });

  app.openapi(route, async (c) => {
    const spec = toSpec(c.req.valid('query'), { quality: config.defaultQuality });
    c.set('sourceHostname', spec.url.hostname);
    const ifNoneMatch = parseIfNoneMatch(c.req.header('If-None-Match'));
    const outcome = await processImage(spec, ifNoneMatch, deps, c.var.log);
    switch (outcome.kind) {
      case 'not_modified':
        return c.body(null, 304, { ETag: outcome.etag, 'Cache-Control': cacheControl });
      case 'image': {
        const { result } = outcome;
        const resultCache = outcome.fromCache ? 'hit' : 'miss';
        c.set('resultCache', resultCache);
        // Not c.body: Hono's body type needs Uint8Array<ArrayBuffer>, and the pipeline's bytes
        // are typed over ArrayBufferLike.
        return new Response(result.bytes, {
          status: 200,
          headers: {
            'Content-Type': result.contentType,
            'Content-Length': String(result.bytes.byteLength),
            ETag: result.etag,
            'Cache-Control': cacheControl,
            'X-Image-Width': String(result.width),
            'X-Image-Height': String(result.height),
            'X-Image-Format': result.format,
            'X-Result-Cache': resultCache,
            'X-Content-Type-Options': 'nosniff',
            'Content-Disposition': 'inline',
          },
        });
      }
    }
  });
}

function parseIfNoneMatch(header: string | undefined): string[] {
  if (header === undefined) {
    return [];
  }
  return header
    .split(',')
    .map((entry) => entry.trim().replace(/^W\//, ''))
    .filter((entry) => entry !== '');
}
