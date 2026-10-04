import { get, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { buffer } from 'node:stream/consumers';
import { gunzipSync } from 'node:zlib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeUpstream } from './server.ts';

type Upstream = Awaited<ReturnType<typeof startFakeUpstream>>;
type Fetched = { status: number; headers: IncomingHttpHeaders; body: Buffer; localPort: number };

let upstream: Upstream;

beforeAll(async () => {
  upstream = await startFakeUpstream();
});

afterAll(async () => {
  await upstream.close();
});

function respondTo(path: string, headers: Record<string, string> = {}): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    get(new URL(path, upstream.url), { headers, agent: false }, resolve).on('error', reject);
  });
}

async function fetchPath(path: string, headers: Record<string, string> = {}): Promise<Fetched> {
  const response = await respondTo(path, headers);
  const localPort = response.socket.localPort ?? 0;
  return {
    status: response.statusCode ?? 0,
    headers: response.headers,
    body: await buffer(response),
    localPort,
  };
}

function recordFor(path: string): ReturnType<Upstream['requests']>[number] {
  const record = upstream.requests().find((r) => r.path === path);
  if (record === undefined) throw new Error(`no request recorded for ${path}`);
  return record;
}

describe('startFakeUpstream', () => {
  it('listens on 127.0.0.1', () => {
    expect(upstream.url.hostname).toBe('127.0.0.1');
    expect(Number(upstream.url.port)).toBeGreaterThan(0);
  });

  const images: { format: string; contentType: string; decodedAs: string }[] = [
    { format: 'jpeg', contentType: 'image/jpeg', decodedAs: 'jpeg' },
    { format: 'png', contentType: 'image/png', decodedAs: 'png' },
    { format: 'webp', contentType: 'image/webp', decodedAs: 'webp' },
    { format: 'gif', contentType: 'image/gif', decodedAs: 'gif' },
    { format: 'avif', contentType: 'image/avif', decodedAs: 'heif' },
    { format: 'tiff', contentType: 'image/tiff', decodedAs: 'tiff' },
  ];
  for (const { format, contentType, decodedAs } of images) {
    it(`serves a generated ${format} with its content type`, async () => {
      const response = await fetchPath(`/image/${format}?w=30&h=20&pattern=quadrants`);
      const metadata = await sharp(response.body).metadata();
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe(contentType);
      expect([metadata.format, metadata.width, metadata.height]).toEqual([decodedAs, 30, 20]);
    });
  }

  it('passes orientation and alpha through to the generator', async () => {
    const oriented = await fetchPath('/image/jpeg?w=30&h=20&orientation=6');
    const transparent = await fetchPath('/image/png?w=30&h=20&alpha=true');
    expect((await sharp(oriented.body).metadata()).orientation).toBe(6);
    expect((await sharp(transparent.body).metadata()).hasAlpha).toBe(true);
  });

  const rejected: { name: string; path: string; status: number }[] = [
    { name: 'an unknown image format', path: '/image/bmp', status: 404 },
    { name: 'a zero width', path: '/image/png?w=0', status: 400 },
    { name: 'an unknown pattern', path: '/image/png?pattern=stripes', status: 400 },
    { name: 'an unsupported orientation', path: '/image/png?orientation=2', status: 400 },
    { name: 'an orientation gif cannot carry', path: '/image/gif?orientation=6', status: 400 },
    { name: 'alpha jpeg cannot carry', path: '/image/jpeg?alpha=true', status: 400 },
    { name: 'a redirect without a target', path: '/redirect', status: 400 },
    { name: 'a redirect status outside 3xx', path: '/redirect?to=/html&status=200', status: 400 },
    { name: 'a chain of zero hops', path: '/redirect/chain/0?to=/html', status: 400 },
    { name: 'a status below 200', path: '/status/101', status: 400 },
    { name: 'an unknown path', path: '/nothing-here', status: 404 },
  ];
  for (const c of rejected) {
    it(`answers ${String(c.status)} to ${c.name}`, async () => {
      expect((await fetchPath(c.path)).status).toBe(c.status);
    });
  }

  it('redirects with 302 by default and with the given status', async () => {
    const plain = await fetchPath('/redirect?to=/html');
    const permanent = await fetchPath('/redirect?to=http%3A%2F%2F10.0.0.1%2Fx&status=308');
    expect([plain.status, plain.headers.location]).toEqual([302, '/html']);
    expect([permanent.status, permanent.headers.location]).toEqual([308, 'http://10.0.0.1/x']);
  });

  it('redirects through n hops of 302 before reaching the target', async () => {
    const target = 'http://127.0.0.1:1/final';
    let location = `/redirect/chain/3?to=${encodeURIComponent(target)}`;
    const statuses: number[] = [];
    while (location !== target) {
      const response = await fetchPath(location);
      statuses.push(response.status);
      location = response.headers.location ?? target;
    }
    expect(statuses).toEqual([302, 302, 302]);
  });

  it('sends /slow headers immediately and holds the body', async () => {
    const response = await respondTo('/slow?ms=60000&format=png');
    expect([response.statusCode, response.headers['content-type']]).toEqual([200, 'image/png']);
    expect(recordFor('/slow?ms=60000&format=png').bytesSent).toBe(0);
    response.destroy();
  });

  it('sends the /slow body once the delay has passed', async () => {
    const response = await fetchPath('/slow?ms=1&format=webp');
    expect((await sharp(response.body).metadata()).format).toBe('webp');
  });

  it('sends nothing on /slow-headers until the delay has passed', async () => {
    const outcome = await new Promise<string>((resolve) => {
      const request = get(new URL('/slow-headers?ms=60000', upstream.url), { agent: false });
      request.on('response', () => {
        resolve('response');
      });
      request.setTimeout(100, () => {
        request.destroy();
        resolve('timed out');
      });
      request.on('error', () => undefined);
    });
    expect(outcome).toBe('timed out');
    expect(recordFor('/slow-headers?ms=60000').bytesSent).toBe(0);
  });

  it('answers /slow-headers with an image after the delay', async () => {
    const response = await fetchPath('/slow-headers?ms=1');
    expect(response.status).toBe(200);
    expect((await sharp(response.body).metadata()).format).toBe('jpeg');
  });

  it('declares and sends the requested length on /huge', async () => {
    const response = await fetchPath('/huge?bytes=1000000');
    expect(response.headers['content-length']).toBe('1000000');
    expect(response.body.byteLength).toBe(1_000_000);
    expect(recordFor('/huge?bytes=1000000').bytesSent).toBe(1_000_000);
  });

  it('holds the /huge body for ms after sending its headers', async () => {
    const response = await respondTo('/huge?bytes=1000000&ms=60000');
    expect(response.headers['content-length']).toBe('1000000');
    expect(recordFor('/huge?bytes=1000000&ms=60000').bytesSent).toBe(0);
    response.destroy();
  });

  it('sends the whole /huge body once the hold has passed', async () => {
    const response = await fetchPath('/huge?bytes=100000&ms=1');
    expect(response.body.byteLength).toBe(100_000);
  });

  it('counts /huge bytes as the socket accepts them, so an abandoned body stays short', async () => {
    const response = await respondTo('/huge?bytes=100000000');
    response.destroy();
    expect(recordFor('/huge?bytes=100000000').bytesSent).toBeLessThan(100_000_000);
  });

  it('sends /no-length chunked with no Content-Length', async () => {
    const response = await fetchPath('/no-length?bytes=200000');
    expect(response.headers['content-length']).toBeUndefined();
    expect(response.headers['transfer-encoding']).toBe('chunked');
    expect(response.body.byteLength).toBe(200_000);
  });

  it('labels PNG bytes as text/html on /wrong-type', async () => {
    const response = await fetchPath('/wrong-type');
    expect(response.headers['content-type']).toBe('text/html');
    expect((await sharp(response.body).metadata()).format).toBe('png');
  });

  it('serves HTML and SVG that are not raster images', async () => {
    const html = await fetchPath('/html');
    const svg = await fetchPath('/svg');
    expect(html.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(html.body.toString()).toMatch(/^<!doctype html>/);
    expect(svg.headers['content-type']).toBe('image/svg+xml');
    expect(svg.body.toString()).toMatch(/^<svg /);
  });

  it('serves a JPEG cut off before its dimensions on /truncated', async () => {
    const response = await fetchPath('/truncated');
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect([...response.body.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    await expect(sharp(response.body).metadata()).rejects.toThrow();
  });

  it('serves a gzip-encoded image on /gzip', async () => {
    const response = await fetchPath('/gzip');
    expect(response.headers['content-encoding']).toBe('gzip');
    expect((await sharp(gunzipSync(response.body)).metadata()).format).toBe('jpeg');
  });

  it('answers /status/:code with that status and a short text body', async () => {
    const response = await fetchPath('/status/503');
    expect([response.status, response.body.toString()]).toEqual([503, 'Status 503']);
  });

  for (const code of [204, 205, 304]) {
    it(`answers /status/${String(code)} with no body and no Content-Length`, async () => {
      const response = await fetchPath(`/status/${String(code)}`);
      expect([
        response.status,
        response.headers['content-length'],
        response.body.byteLength,
      ]).toEqual([code, undefined, 0]);
    });
  }

  it('serves an image with validators and headers that must not be forwarded', async () => {
    const response = await fetchPath('/with-validators');
    expect(response.headers).toMatchObject({
      etag: '"fake-upstream-1"',
      'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
      'set-cookie': ['session=fake; Path=/'],
      'x-powered-by': 'fake-upstream',
    });
    expect((await sharp(response.body).metadata()).format).toBe('jpeg');
  });

  it('takes the validators from etag and lastModified, omitting one given empty', async () => {
    const replaced = await fetchPath(
      '/with-validators?etag=%22v2%22&lastModified=Thu,%2002%20Jan%202025%2000:00:00%20GMT',
    );
    expect([replaced.headers.etag, replaced.headers['last-modified']]).toEqual([
      '"v2"',
      'Thu, 02 Jan 2025 00:00:00 GMT',
    ]);
    const lastModifiedOnly = await fetchPath('/with-validators?etag=');
    expect([lastModifiedOnly.headers.etag, lastModifiedOnly.headers['last-modified']]).toEqual([
      undefined,
      'Wed, 01 Jan 2025 00:00:00 GMT',
    ]);
    const neither = await fetchPath('/with-validators?etag=&lastModified=');
    expect([neither.headers.etag, neither.headers['last-modified']]).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('sets no Cache-Control', async () => {
    const responses = await Promise.all(
      ['/image/png', '/with-validators', '/status/500', '/nothing-here'].map((path) =>
        fetchPath(path),
      ),
    );
    expect(responses.map((r) => r.headers['cache-control'])).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('records each request with its method, path, headers, and body bytes sent', async () => {
    const path = '/image/png?w=5&h=5&pattern=solid';
    const response = await fetchPath(path, { 'X-Image-Service-Fetch': '1' });
    const record = recordFor(path);
    expect([record.method, record.path, record.bytesSent]).toEqual([
      'GET',
      path,
      response.body.byteLength,
    ]);
    expect(record.headers['x-image-service-fetch']).toBe('1');
  });

  it('records each TCP connection with its remote address and port', async () => {
    const response = await fetchPath('/html');
    expect(upstream.connections()).toContainEqual({
      remoteAddress: '127.0.0.1',
      remotePort: response.localPort,
    });
  });

  it('closes while a delayed response is still pending', async () => {
    const other = await startFakeUpstream();
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      get(new URL('/slow?ms=60000', other.url), { agent: false }, resolve).on('error', reject);
    });
    response.on('error', () => undefined);
    await other.close();
    expect(response.complete).toBe(false);
  });
});
