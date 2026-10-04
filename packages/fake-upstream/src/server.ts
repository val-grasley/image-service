import { once } from 'node:events';
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import { gzipSync } from 'node:zlib';
import type { SourceType } from '@image-service/sdk';
import { generateImage, ORIENTATIONS, PATTERNS, type ImageSpec } from './generator.ts';

type RequestRecord = {
  method: string;
  path: string;
  headers: Record<string, string>;
  bytesSent: number;
};
type ConnectionRecord = { remoteAddress: string; remotePort: number };

type FakeUpstream = {
  url: URL;
  close(): Promise<void>;
  connections(): ConnectionRecord[];
  requests(): RequestRecord[];
};

const CONTENT_TYPES: Record<SourceType, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  tiff: 'image/tiff',
};

const DEFAULT_IMAGE: ImageSpec = { width: 64, height: 48, format: 'jpeg' };
const MAX_DIMENSION = 10_000;
const MAX_DELAY_MS = 600_000;
const CHUNK_BYTES = 64 * 1024;
// Ends inside the quantization tables, so the signature survives but the frame header that
// holds the dimensions does not.
const TRUNCATED_JPEG_BYTES = 100;

const HTML = '<!doctype html><title>Not an image</title><p>Not an image.</p>';
// RFC 9110 forbids content on these, so they get no text body and no Content-Length.
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';

const BODILESS_STATUSES: readonly number[] = [204, 205, 304];

export async function startFakeUpstream(options: { port?: number } = {}): Promise<FakeUpstream> {
  const requests: RequestRecord[] = [];
  const connections: ConnectionRecord[] = [];
  const server = createServer((req, res) => {
    const record: RequestRecord = {
      method: req.method ?? '',
      path: req.url ?? '',
      headers: flattenHeaders(req),
      bytesSent: 0,
    };
    requests.push(record);
    respond(res, record).catch((error: unknown) => {
      fail(res, error);
    });
  });
  server.on('connection', (socket) => {
    connections.push({
      remoteAddress: socket.remoteAddress ?? '',
      remotePort: socket.remotePort ?? 0,
    });
  });
  server.listen(options.port ?? 0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The fake upstream is not listening on a TCP port.');
  }
  return {
    url: new URL(`http://127.0.0.1:${String(address.port)}/`),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      }),
    connections: () => [...connections],
    requests: () => [...requests],
  };
}

async function respond(res: ServerResponse, record: RequestRecord): Promise<void> {
  const { pathname, searchParams: query } = new URL(record.path, 'http://127.0.0.1');
  switch (pathname) {
    case '/redirect': {
      const status = integer('status', query.get('status'), 300, 399, 302);
      send(res, record, status, { Location: required(query, 'to') }, '');
      return;
    }
    case '/slow': {
      const ms = integer('ms', query.get('ms'), 0, MAX_DELAY_MS);
      const format = query.get('format') ?? DEFAULT_IMAGE.format;
      if (!isSourceType(format)) throw new RangeError(`Unknown format ${format}.`);
      const image = await generateImage({ ...DEFAULT_IMAGE, format });
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[format],
        'Content-Length': image.bytes.byteLength,
      });
      res.flushHeaders();
      if (!(await hold(res, ms))) return;
      res.end(image.bytes);
      record.bytesSent += image.bytes.byteLength;
      return;
    }
    case '/slow-headers': {
      const ms = integer('ms', query.get('ms'), 0, MAX_DELAY_MS);
      const image = await generateImage(DEFAULT_IMAGE);
      if (!(await hold(res, ms))) return;
      send(res, record, 200, { 'Content-Type': CONTENT_TYPES[image.format] }, image.bytes);
      return;
    }
    case '/huge': {
      const bytes = integer('bytes', query.get('bytes'), 0, Number.MAX_SAFE_INTEGER);
      const ms = integer('ms', query.get('ms'), 0, MAX_DELAY_MS, 0);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes });
      res.flushHeaders();
      if (!(await hold(res, ms))) return;
      await streamZeros(res, record, bytes);
      return;
    }
    case '/no-length': {
      const bytes = integer('bytes', query.get('bytes'), 0, Number.MAX_SAFE_INTEGER);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Transfer-Encoding': 'chunked',
      });
      await streamZeros(res, record, bytes);
      return;
    }
    case '/wrong-type': {
      const image = await generateImage({ ...DEFAULT_IMAGE, format: 'png' });
      send(res, record, 200, { 'Content-Type': 'text/html' }, image.bytes);
      return;
    }
    case '/html':
      send(res, record, 200, { 'Content-Type': 'text/html; charset=utf-8' }, HTML);
      return;
    case '/svg':
      send(res, record, 200, { 'Content-Type': 'image/svg+xml' }, SVG);
      return;
    case '/truncated': {
      const image = await generateImage(DEFAULT_IMAGE);
      const bytes = image.bytes.subarray(0, TRUNCATED_JPEG_BYTES);
      send(res, record, 200, { 'Content-Type': CONTENT_TYPES[image.format] }, bytes);
      return;
    }
    case '/gzip': {
      const image = await generateImage(DEFAULT_IMAGE);
      const headers = { 'Content-Type': CONTENT_TYPES[image.format], 'Content-Encoding': 'gzip' };
      send(res, record, 200, headers, gzipSync(image.bytes));
      return;
    }
    case '/with-validators': {
      const image = await generateImage(DEFAULT_IMAGE);
      const headers = {
        'Content-Type': CONTENT_TYPES[image.format],
        ETag: '"fake-upstream-1"',
        'Last-Modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
        'Set-Cookie': 'session=fake; Path=/',
        'X-Powered-By': 'fake-upstream',
      };
      send(res, record, 200, headers, image.bytes);
      return;
    }
  }

  const format = /^\/image\/(\w+)$/.exec(pathname)?.[1];
  if (format !== undefined && isSourceType(format)) {
    const pattern = oneOf('pattern', query.get('pattern'), PATTERNS);
    const orientation = oneOf('orientation', query.get('orientation'), ORIENTATIONS);
    const image = await generateImage({
      width: integer('w', query.get('w'), 1, MAX_DIMENSION, DEFAULT_IMAGE.width),
      height: integer('h', query.get('h'), 1, MAX_DIMENSION, DEFAULT_IMAGE.height),
      format,
      alpha: boolean('alpha', query.get('alpha')),
      ...(pattern === undefined ? {} : { pattern }),
      ...(orientation === undefined ? {} : { orientation }),
    });
    send(res, record, 200, { 'Content-Type': CONTENT_TYPES[format] }, image.bytes);
    return;
  }

  const hops = /^\/redirect\/chain\/(\d+)$/.exec(pathname)?.[1];
  if (hops !== undefined) {
    const remaining = integer('n', hops, 1, Number.MAX_SAFE_INTEGER);
    const to = required(query, 'to');
    const location =
      remaining === 1
        ? to
        : `/redirect/chain/${String(remaining - 1)}?${new URLSearchParams({ to }).toString()}`;
    send(res, record, 302, { Location: location }, '');
    return;
  }

  const code = /^\/status\/(\d+)$/.exec(pathname)?.[1];
  if (code !== undefined) {
    const status = integer('code', code, 200, 599);
    if (BODILESS_STATUSES.includes(status)) {
      res.writeHead(status).end();
      return;
    }
    send(res, record, status, { 'Content-Type': 'text/plain' }, `Status ${String(status)}`);
    return;
  }

  send(res, record, 404, { 'Content-Type': 'text/plain' }, 'Not found');
}

function send(
  res: ServerResponse,
  record: RequestRecord,
  status: number,
  headers: OutgoingHttpHeaders,
  body: Uint8Array | string,
): void {
  const bytes = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, { ...headers, 'Content-Length': bytes.byteLength });
  res.end(bytes);
  record.bytesSent += bytes.byteLength;
}

async function streamZeros(
  res: ServerResponse,
  record: RequestRecord,
  total: number,
): Promise<void> {
  const chunk = Buffer.alloc(CHUNK_BYTES);
  for (let sent = 0; sent < total && !res.destroyed;) {
    const piece = chunk.subarray(0, Math.min(CHUNK_BYTES, total - sent));
    sent += piece.byteLength;
    record.bytesSent += piece.byteLength;
    if (!res.write(piece)) await drained(res);
  }
  res.end();
}

function drained(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

function hold(res: ServerResponse, ms: number): Promise<boolean> {
  if (res.destroyed) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const closed = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      res.off('close', closed);
      resolve(true);
    }, ms);
    res.once('close', closed);
  });
}

function fail(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (error instanceof RangeError) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end(error.message);
    return;
  }
  console.error(error);
  res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Internal error');
}

function flattenHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, values] of Object.entries(req.headersDistinct)) {
    if (values !== undefined) headers[name] = values.join(', ');
  }
  return headers;
}

function isSourceType(value: string): value is SourceType {
  return Object.hasOwn(CONTENT_TYPES, value);
}

function required(query: URLSearchParams, name: string): string {
  const value = query.get(name);
  if (value === null || value === '') throw new RangeError(`${name} is required.`);
  return value;
}

function integer(
  name: string,
  raw: string | null,
  min: number,
  max: number,
  fallback?: number,
): number {
  if (raw === null && fallback !== undefined) return fallback;
  const value = Number(raw);
  if (raw === null || raw === '' || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${String(min)} and ${String(max)}.`);
  }
  return value;
}

function boolean(name: string, raw: string | null): boolean {
  switch (raw) {
    case null:
    case '0':
    case 'false':
      return false;
    case '1':
    case 'true':
      return true;
    default:
      throw new RangeError(`${name} must be true or false.`);
  }
}

function oneOf<T extends string | number>(
  name: string,
  raw: string | null,
  allowed: readonly T[],
): T | undefined {
  if (raw === null) return undefined;
  const value = allowed.find((candidate) => String(candidate) === raw);
  if (value === undefined) throw new RangeError(`${name} must be one of ${allowed.join(', ')}.`);
  return value;
}
