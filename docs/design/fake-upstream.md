# Design: fake upstream

`packages/fake-upstream` is a dev-only package: an image generator and a `node:http` server
that serves scenarios for the API's integration tests and the end-to-end suite. It is the
only source of image bytes in any test, and no image file is checked in.

## Generator

```ts
import type { SourceType } from '@image-service/sdk';
type GeneratedImage = { bytes: Uint8Array; width: number; height: number; format: SourceType };

const PATTERNS = ['solid', 'quadrants', 'noise'] as const;
const ORIENTATIONS = [1, 3, 6, 8] as const;

function generateImage(spec: {
  width: number;
  height: number;
  format: SourceType;
  pattern?: (typeof PATTERNS)[number];          // default 'solid'
  orientation?: (typeof ORIENTATIONS)[number];
  alpha?: boolean;
}): Promise<GeneratedImage>;
```

The package depends on the SDK workspace for `SourceType` and on sharp; it must not depend
on the API, whose tests depend on it. Built with sharp. `solid` is one color; `quadrants` is four distinct colors so crop placement
and orientation are observable by sampling pixels; `noise` compresses poorly, for byte-cap
tests. `orientation` writes the EXIF tag through `withMetadata({ orientation })` on the
fixture only. `alpha` adds an alpha channel at half opacity on every pixel. The tuples are
exported so the server parses query values against the same sets.

A spec the encoder cannot honor is refused with a `RangeError` rather than encoded into a
fixture that lacks what the spec claims (decision 36): `orientation` for GIF and AVIF,
because sharp drops the tag for GIF and pre-rotates AVIF instead of tagging it; `alpha` for
JPEG and TIFF, which sharp writes without the channel, and for GIF, which keeps only
on-or-off transparency. Results, including refusals, are memoized per spec within a
process.

## Server

```ts
type RequestRecord = { method: string; path: string; headers: Record<string, string>; bytesSent: number };
type ConnectionRecord = { remoteAddress: string; remotePort: number };

function startFakeUpstream(options?: { port?: number }): Promise<{
  url: URL;
  close(): Promise<void>;
  connections(): ConnectionRecord[];
  requests(): RequestRecord[];
}>;
```

Binds `127.0.0.1` only (not `localhost`, which the name rule blocks, and not `::1`).
Ephemeral port by default; a fixed port for the end-to-end suite. Every request and every
TCP connection is recorded in process so the API's tests can assert on what the fetcher did;
the end-to-end suite runs in another process and does not use the records.

`RequestRecord.path` is the request target including the query string, so redirect hops and
image variants are distinguishable. Header names are lowercase and repeated headers are
joined with `, `. `bytesSent` counts response body bytes as the server hands them to the
socket; bodies stream with backpressure, so the count stops growing when a client goes away.
Routes that serve an image without naming one serve a 64 by 48 JPEG. A malformed parameter,
or a spec the generator refuses, is answered 400 with a one-line text body.

| Path | Behavior |
|---|---|
| `/image/:format?w=&h=&pattern=&orientation=&alpha=` | A generated image with the correct `Content-Type` |
| `/redirect?to=&status=` | `Location: to` with the given status (default 302) |
| `/redirect/chain/:n?to=` | `n` hops of 302 ending at `to` |
| `/slow?ms=&format=` | Headers immediately, body after `ms` |
| `/slow-headers?ms=` | Accepts the connection, sends nothing for `ms`, then a 200 |
| `/huge?bytes=&ms=` | `Content-Length: bytes` at once, then after `ms` (default 0) a body of that length; while the body is held, the request's `bytesSent` is 0 |
| `/no-length?bytes=` | Chunked body of that length, no `Content-Length` |
| `/wrong-type` | PNG bytes with `Content-Type: text/html` |
| `/html`, `/svg`, `/truncated` | Non-image, SVG, and a cut-off JPEG header |
| `/gzip` | A gzip-encoded image with `Content-Encoding: gzip` |
| `/status/:code` | That status (200 to 599) with a short text body; 204, 205, and 304 carry no body and no `Content-Length` |
| `/with-validators` | An image with `ETag`, `Last-Modified`, `Set-Cookie`, `X-Powered-By` |

Unknown paths are 404. The server sets no `Cache-Control`.

## Use

- API integration tests: `startFakeUpstream()` in `beforeAll`, `ALLOWED_HOSTS` set to
  `127.0.0.1:<port>` through `testConfig`.
- End-to-end: Playwright's `webServer` array starts the server on a fixed port through the
  CLI entry, then the API with `ALLOWED_HOSTS` pointing at it. There is no `globalSetup`.
- Pipeline unit tests: `generateImage` directly, no server.

The package exposes two subpaths, `@image-service/fake-upstream/generator` and
`@image-service/fake-upstream/server`, named for their concepts; there is no index barrel.
A CLI entry (`fake-upstream --port N`, the manifest's `bin` pointing at `src/cli.ts` so npm
links it at install time and Node runs it through type stripping) exists only for
Playwright's `webServer` command.
