import type { OpenAPIHono } from '@hono/zod-openapi';
import { SwaggerUI } from '@hono/swagger-ui';
import type { ErrorCode } from '@image-service/sdk';
import { html, raw } from 'hono/html';
import type { AppEnv } from '../context.ts';
import { ERROR_CODES, STATUS } from '../errors.ts';
import { DOCUMENTATION_CACHE_CONTROL } from '../openapi.ts';

// Without a version, @hono/swagger-ui loads the latest swagger-ui-dist from jsDelivr, so a
// release there would change this page between two requests.
const SWAGGER_UI_VERSION = '5.33.1';

const EXPLANATIONS: Record<ErrorCode, string> = {
  invalid_parameter:
    'A query parameter is missing, out of range, or not one the endpoint accepts; errors names each one and says what is accepted.',
  url_not_allowed:
    'The fetch policy refuses the source URL, a redirect hop, or an address it resolves to, or the request came from this service itself.',
  not_found: 'No endpoint exists at this path.',
  method_not_allowed:
    'The path exists but does not accept this method; the Allow header lists the methods it does.',
  source_too_large: 'The source exceeds the byte limit or the pixel limit.',
  unsupported_source_type:
    'Judged from its bytes, the source is not a JPEG, PNG, WebP, GIF, AVIF, or TIFF image.',
  output_too_large:
    'The encoded image exceeds the output byte limit, or an AVIF output would exceed the AVIF pixel limit; request smaller dimensions or another format.',
  rate_limited:
    'This client sent more requests this minute than the limit allows; Retry-After says when to try again.',
  internal_error: 'The service failed unexpectedly; quote the requestId when reporting it.',
  transform_timeout: 'Decoding, resizing, and encoding the image took longer than its time budget.',
  upstream_error:
    'The source server was unreachable, refused the connection, sent a compressed body, or answered with a non-2xx status, which upstreamStatus gives.',
  too_many_redirects: 'The source redirected more times than the service follows.',
  upstream_timeout: 'The source did not deliver the whole image within the fetch budget.',
};

export function addDocsRoute(app: OpenAPIHono<AppEnv>): void {
  const errors = ERROR_CODES.map(
    (code) =>
      html`<section id="error-${code}">
        <h3><code>${code}</code></h3>
        <p>${String(STATUS[code].status)} ${STATUS[code].title}. ${EXPLANATIONS[code]}</p>
      </section>`,
  );
  const page = html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Image processing service</title>
      </head>
      <body>
        <h1>Image processing service</h1>
        <p>
          The specification is at <a href="/openapi.json">/openapi.json</a>. Every error is an
          <code>application/problem+json</code> body whose <code>type</code> links to its section
          below.
        </p>
        <h2>Errors</h2>
        ${errors}
        <h2>Endpoints</h2>
        ${raw(SwaggerUI({ url: '/openapi.json', version: SWAGGER_UI_VERSION }))}
      </body>
    </html>`;

  app.get('/docs', (c) => c.html(page, 200, { 'Cache-Control': DOCUMENTATION_CACHE_CONTROL }));
}
