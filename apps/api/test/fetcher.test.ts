import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { startFakeUpstream } from '@image-service/fake-upstream/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.ts';
import { ServiceError } from '../src/errors.ts';
import { createLogger } from '../src/observability/logger.ts';
import { fetchSource, type FetchedSource, type FetcherDeps } from '../src/source/fetcher.ts';
import { testConfig } from './test-config.ts';

type FakeUpstream = Awaited<ReturnType<typeof startFakeUpstream>>;

let fake: FakeUpstream;
let lines: string[];

beforeEach(async () => {
  fake = await startFakeUpstream();
  lines = [];
});

afterEach(async () => {
  await fake.close();
});

function config(overrides: Partial<Config> = {}): Config {
  return testConfig({ allowedHosts: new Set([fake.url.host]), ...overrides });
}

function deps(settings: Config = config(), extra: Partial<FetcherDeps> = {}): FetcherDeps {
  return { policy: settings, limits: settings, serviceVersion: 'test-version', ...extra };
}

function fetchFrom(url: URL, fetcherDeps: FetcherDeps): Promise<FetchedSource> {
  return fetchSource(
    url,
    fetcherDeps,
    createLogger('debug', (line) => lines.push(line)),
  );
}

const at = (path: string): URL => new URL(path, fake.url);

const redirectTo = (to: string, status = 302): URL =>
  at(`/redirect?${new URLSearchParams({ to, status: String(status) }).toString()}`);

function resolver(addresses: string[]) {
  return vi.fn<(hostname: string) => Promise<string[]>>(() => Promise.resolve(addresses));
}

async function rejection(promise: Promise<unknown>): Promise<ServiceError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ServiceError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the fetch to be rejected.');
}

// Counts TCP client sockets created in this process, so a test can show that no connection
// was attempted anywhere, not only that none reached the fake upstream.
async function clientSocketsDuring(run: () => Promise<unknown>): Promise<number> {
  let sockets = 0;
  const onSocket = (): void => {
    sockets += 1;
  };
  subscribe('net.client.socket', onSocket);
  try {
    await run();
  } finally {
    unsubscribe('net.client.socket', onSocket);
  }
  return sockets;
}

function logEntries(): unknown[] {
  return lines.map((line): unknown => JSON.parse(line));
}

describe('redirects', () => {
  for (const status of [301, 302, 303, 307, 308]) {
    it(`follows a ${String(status)} to a relative Location`, async () => {
      const source = await fetchFrom(redirectTo('/image/png', status), deps());
      expect(source.finalUrl.href).toBe(at('/image/png').href);
      expect(source.bytes.byteLength).toBeGreaterThan(0);
      expect(fake.requests().map((request) => request.path)).toEqual([
        `/redirect?to=%2Fimage%2Fpng&status=${String(status)}`,
        '/image/png',
      ]);
    });
  }

  it('follows an absolute Location', async () => {
    const source = await fetchFrom(redirectTo(at('/image/webp').href), deps());
    expect(source.finalUrl.href).toBe(at('/image/webp').href);
  });

  it('follows a chain of MAX_REDIRECTS redirects', async () => {
    const settings = config();
    const chain = at(`/redirect/chain/${String(settings.maxRedirects)}?to=/image/jpeg`);
    const source = await fetchFrom(chain, deps(settings));
    expect(source.finalUrl.pathname).toBe('/image/jpeg');
    expect(fake.requests()).toHaveLength(settings.maxRedirects + 1);
  });

  it('refuses a chain of MAX_REDIRECTS + 1 redirects', async () => {
    const settings = config();
    const chain = at(`/redirect/chain/${String(settings.maxRedirects + 1)}?to=/image/jpeg`);
    const error = await rejection(fetchFrom(chain, deps(settings)));
    expect(error.code).toBe('too_many_redirects');
    expect(fake.requests().map((request) => request.path)).not.toContain('/image/jpeg');
  });

  it('refuses a hop to a name that resolves to a private address', async () => {
    const resolve = resolver(['10.0.0.1']);
    let error: ServiceError | undefined;
    const sockets = await clientSocketsDuring(async () => {
      error = await rejection(
        fetchFrom(redirectTo('http://internal.example/image/jpeg'), deps(config(), { resolve })),
      );
    });
    expect(error?.code).toBe('url_not_allowed');
    expect(error?.detail).toContain('10.0.0.1');
    expect(resolve).toHaveBeenCalledWith('internal.example');
    expect(sockets).toBe(1);
    expect(fake.connections()).toHaveLength(1);
  });

  it('refuses a hop to a PUBLIC_HOSTS name without resolving it', async () => {
    const resolve = resolver(['203.0.113.10']);
    const settings = config({ publicHosts: new Set(['images.example']) });
    const error = await rejection(
      fetchFrom(redirectTo('https://images.example/a.jpg'), deps(settings, { resolve })),
    );
    expect(error.code).toBe('url_not_allowed');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses a hop to a loopback port that ALLOWED_HOSTS does not list', async () => {
    const other = await startFakeUpstream();
    try {
      const error = await rejection(fetchFrom(redirectTo(other.url.href), deps()));
      expect(error.code).toBe('url_not_allowed');
      expect(other.connections()).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it('treats a redirect without Location as upstream_error', async () => {
    const error = await rejection(fetchFrom(at('/status/302'), deps()));
    expect(error).toMatchObject({ code: 'upstream_error', upstreamStatus: 302 });
  });

  it('treats an unparseable Location as upstream_error', async () => {
    const error = await rejection(fetchFrom(redirectTo('http://['), deps()));
    expect(error).toMatchObject({ code: 'upstream_error', upstreamStatus: 302 });
  });

  it('does not follow a 300', async () => {
    const error = await rejection(fetchFrom(at('/status/300'), deps()));
    expect(error).toMatchObject({ code: 'upstream_error', upstreamStatus: 300 });
  });
});

describe('size and encoding', () => {
  it('refuses a Content-Length over the cap before reading any of the body', async () => {
    const settings = config();
    const bytes = settings.maxSourceBytes + 1;
    const ms = settings.fetchTotalTimeoutMs * 10;
    const error = await rejection(
      fetchFrom(at(`/huge?bytes=${String(bytes)}&ms=${String(ms)}`), deps(settings)),
    );
    expect(error.code).toBe('source_too_large');
    expect(fake.requests()[0]?.bytesSent).toBe(0);
  });

  it('accepts a body of exactly the cap', async () => {
    const settings = config();
    const source = await fetchFrom(
      at(`/huge?bytes=${String(settings.maxSourceBytes)}`),
      deps(settings),
    );
    expect(source.bytes.byteLength).toBe(settings.maxSourceBytes);
  });

  it('accepts a body without Content-Length of exactly the cap', async () => {
    const settings = config();
    const source = await fetchFrom(
      at(`/no-length?bytes=${String(settings.maxSourceBytes)}`),
      deps(settings),
    );
    expect(source.bytes.byteLength).toBe(settings.maxSourceBytes);
  });

  it('refuses an oversized body without Content-Length and abandons the stream', async () => {
    const bytes = 64_000_000;
    const error = await rejection(fetchFrom(at(`/no-length?bytes=${String(bytes)}`), deps()));
    expect(error.code).toBe('source_too_large');
    expect(fake.requests()[0]?.bytesSent).toBeLessThan(bytes);
  });

  it('refuses Content-Encoding gzip', async () => {
    const error = await rejection(fetchFrom(at('/gzip'), deps()));
    expect(error.code).toBe('upstream_error');
    expect(error.detail).toContain('gzip');
  });
});

describe('upstream failures', () => {
  for (const status of [404, 500]) {
    it(`reports an upstream ${String(status)} as upstream_error with its status`, async () => {
      const error = await rejection(fetchFrom(at(`/status/${String(status)}`), deps()));
      expect(error).toMatchObject({ code: 'upstream_error', upstreamStatus: status });
    });
  }

  it('reports a refused connection as upstream_error', async () => {
    const closed = await startFakeUpstream();
    await closed.close();
    const settings = config({ allowedHosts: new Set([closed.url.host]) });
    const error = await rejection(fetchFrom(new URL('/image/jpeg', closed.url), deps(settings)));
    expect(error.code).toBe('upstream_error');
  });

  it('reports a body slower than the total budget as upstream_timeout', async () => {
    const settings = config({ fetchTotalTimeoutMs: 200 });
    const error = await rejection(fetchFrom(at('/slow?ms=60000'), deps(settings)));
    expect(error.code).toBe('upstream_timeout');
  });

  it('reports headers slower than the total budget as upstream_timeout', async () => {
    const settings = config({ fetchTotalTimeoutMs: 200 });
    const error = await rejection(fetchFrom(at('/slow-headers?ms=60000'), deps(settings)));
    expect(error.code).toBe('upstream_timeout');
  });

  it('reports a failed resolution as upstream_error', async () => {
    const resolve = vi.fn<(hostname: string) => Promise<string[]>>(() =>
      Promise.reject(new Error('ENOTFOUND')),
    );
    const error = await rejection(
      fetchFrom(new URL('http://photos.example/a.jpg'), deps(config(), { resolve })),
    );
    expect(error.code).toBe('upstream_error');
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('reports an empty resolution as upstream_error without connecting', async () => {
    let error: ServiceError | undefined;
    const sockets = await clientSocketsDuring(async () => {
      error = await rejection(
        fetchFrom(
          new URL('http://photos.example/a.jpg'),
          deps(config(), { resolve: resolver([]) }),
        ),
      );
    });
    expect(error).toMatchObject({
      code: 'upstream_error',
      detail: 'photos.example resolved to no addresses.',
    });
    expect(sockets).toBe(0);
  });

  it('reports a resolution that outlasts the total budget as upstream_timeout', async () => {
    const settings = config({ fetchTotalTimeoutMs: 200 });
    const resolve = vi.fn<(hostname: string) => Promise<string[]>>(
      () => new Promise<string[]>(() => undefined),
    );
    let error: ServiceError | undefined;
    const sockets = await clientSocketsDuring(async () => {
      error = await rejection(
        fetchFrom(new URL('http://photos.example/a.jpg'), deps(settings, { resolve })),
      );
    });
    expect(error?.code).toBe('upstream_timeout');
    expect(sockets).toBe(0);
  });
});

describe('addresses', () => {
  it('makes no connection when a name resolves to a private address', async () => {
    const resolve = resolver(['127.0.0.1']);
    let error: ServiceError | undefined;
    const sockets = await clientSocketsDuring(async () => {
      error = await rejection(
        fetchFrom(new URL('http://internal.example/image/jpeg'), deps(config(), { resolve })),
      );
    });
    expect(error?.code).toBe('url_not_allowed');
    expect(error?.detail).toBe(
      'Host internal.example resolves to 127.0.0.1, which is in blocked range 127.0.0.0/8.',
    );
    expect(resolve).toHaveBeenCalledOnce();
    expect(sockets).toBe(0);
  });

  it('makes no connection when one of several addresses is private', async () => {
    const resolve = resolver(['203.0.113.10', '10.0.0.1']);
    let error: ServiceError | undefined;
    const sockets = await clientSocketsDuring(async () => {
      error = await rejection(
        fetchFrom(new URL('https://photos.example/a.jpg'), deps(config(), { resolve })),
      );
    });
    expect(error?.code).toBe('url_not_allowed');
    expect(sockets).toBe(0);
  });

  it('connects to the resolved address while sending the requested name', async () => {
    const host = `fake.test:${fake.url.port}`;
    const resolve = resolver(['127.0.0.1']);
    const settings = config({ allowedHosts: new Set([host]) });
    const source = await fetchFrom(
      new URL(`http://${host}/image/jpeg`),
      deps(settings, { resolve }),
    );
    expect(source.finalUrl.host).toBe(host);
    expect(fake.requests()[0]?.headers.host).toBe(host);
  });

  it('resolves each hop exactly once', async () => {
    const host = `fake.test:${fake.url.port}`;
    const resolve = resolver(['127.0.0.1']);
    const settings = config({ allowedHosts: new Set([host]) });
    await fetchFrom(
      new URL(`http://${host}/redirect/chain/2?to=/image/jpeg`),
      deps(settings, { resolve }),
    );
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(fake.requests()).toHaveLength(3);
  });

  it('does not resolve an IP-literal URL', async () => {
    const resolve = resolver(['127.0.0.1']);
    await fetchFrom(at('/image/jpeg'), deps(config(), { resolve }));
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('headers', () => {
  it('sends the loop marker and request headers on every hop', async () => {
    await fetchFrom(at('/redirect/chain/2?to=/image/jpeg'), deps());
    const sent = fake.requests().map((request) => request.headers);
    expect(sent).toHaveLength(3);
    for (const headers of sent) {
      expect(headers).toMatchObject({
        'x-image-service-fetch': '1',
        'accept-encoding': 'identity',
        'user-agent': 'image-service/test-version',
        accept: 'image/jpeg, image/png, image/webp, image/gif, image/avif, image/tiff',
      });
    }
  });

  it('returns the upstream validators and no other upstream header', async () => {
    const source = await fetchFrom(at('/with-validators'), deps());
    expect(Object.keys(source)).toEqual(['bytes', 'finalUrl', 'upstream']);
    expect(source.upstream).toEqual({
      etag: '"fake-upstream-1"',
      lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
    });
  });

  it('returns no validators when the upstream sends none', async () => {
    const source = await fetchFrom(at('/image/jpeg'), deps());
    expect(source.upstream).toEqual({});
  });
});

describe('logging', () => {
  it('logs the fetch by hostname and never the full URL', async () => {
    const source = await fetchFrom(at('/image/jpeg?token=secret-token'), deps());
    expect(logEntries()).toContainEqual(
      expect.objectContaining<Record<string, unknown>>({
        msg: 'source fetched',
        level: 'info',
        hostname: '127.0.0.1',
        upstreamStatus: 200,
        bytes: source.bytes.byteLength,
        hops: 1,
        durationMs: expect.any(Number),
      }),
    );
    expect(lines.join('\n')).not.toContain('finalHostname');
    expect(lines.join('\n')).not.toContain('secret-token');
  });

  it('logs the final hostname when a redirect changes it', async () => {
    const host = `fake.test:${fake.url.port}`;
    const settings = config({ allowedHosts: new Set([host, fake.url.host]) });
    const start = new URL(
      `http://${host}/redirect?${new URLSearchParams({ to: at('/image/jpeg').href }).toString()}`,
    );
    await fetchFrom(start, deps(settings, { resolve: resolver(['127.0.0.1']) }));
    expect(logEntries()).toContainEqual(
      expect.objectContaining({
        msg: 'source fetched',
        hostname: 'fake.test',
        finalHostname: '127.0.0.1',
        hops: 2,
      }),
    );
  });

  it('logs a denial with its reason and the resolved addresses only at debug', async () => {
    await rejection(
      fetchFrom(
        new URL('http://internal.example/a.jpg?token=secret-token'),
        deps(config(), { resolve: resolver(['10.0.0.1']) }),
      ),
    );
    expect(logEntries()).toContainEqual(
      expect.objectContaining({
        msg: 'source denied',
        level: 'info',
        hostname: 'internal.example',
        reason: 'blocked_address',
      }),
    );
    expect(logEntries()).toContainEqual(
      expect.objectContaining({ msg: 'source resolved', level: 'debug', addresses: '10.0.0.1' }),
    );
    expect(lines.join('\n')).not.toContain('secret-token');
  });
});
