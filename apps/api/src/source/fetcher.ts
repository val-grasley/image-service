import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { Agent, request, type Dispatcher } from 'undici';
import type { Config } from '../config.ts';
import { ServiceError } from '../errors.ts';
import type { Logger } from '../observability/logger.ts';
import { checkAddresses, checkUrl, type Decision, type PolicyConfig } from './policy.ts';

export type FetchedSource = {
  bytes: Uint8Array;
  finalUrl: URL;
  upstream: { etag?: string; lastModified?: string };
};

type FetchLimits = Pick<
  Config,
  'fetchConnectTimeoutMs' | 'fetchTotalTimeoutMs' | 'maxRedirects' | 'maxSourceBytes'
>;

export type FetcherDeps = {
  resolve?: (hostname: string) => Promise<string[]>;
  policy: PolicyConfig;
  limits: FetchLimits;
  serviceVersion: string;
};

type Hop =
  | { kind: 'redirect'; location: URL }
  | { kind: 'body'; status: number; bytes: Uint8Array; upstream: FetchedSource['upstream'] };

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const ACCEPT = 'image/jpeg, image/png, image/webp, image/gif, image/avif, image/tiff';

export const LOOP_MARKER_HEADER = 'x-image-service-fetch';

export async function fetchSource(
  url: URL,
  deps: FetcherDeps,
  log: Logger,
): Promise<FetchedSource> {
  const started = performance.now();
  const signal = AbortSignal.timeout(deps.limits.fetchTotalTimeoutMs);
  let current = url;
  let previous: URL | undefined;
  for (let redirects = 0; ; redirects++) {
    const addresses = await admit(current, previous, deps, log, signal);
    const hop = await requestHop(current, addresses, deps, signal);
    if (hop.kind === 'body') {
      log.info('source fetched', {
        hostname: url.hostname,
        finalHostname: current.hostname === url.hostname ? undefined : current.hostname,
        upstreamStatus: hop.status,
        bytes: hop.bytes.byteLength,
        hops: redirects + 1,
        durationMs: Math.round(performance.now() - started),
      });
      return { bytes: hop.bytes, finalUrl: current, upstream: hop.upstream };
    }
    if (redirects === deps.limits.maxRedirects) {
      throw new ServiceError(
        'too_many_redirects',
        `The source redirected more than ${String(deps.limits.maxRedirects)} times.`,
      );
    }
    previous = current;
    current = hop.location;
  }
}

async function admit(
  url: URL,
  previous: URL | undefined,
  deps: FetcherDeps,
  log: Logger,
  signal: AbortSignal,
): Promise<string[]> {
  enforce(checkUrl(url, previous, deps.policy), url, log);
  const literal = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  let addresses = [literal];
  if (isIP(literal) === 0) {
    addresses = await resolveHost(url.hostname, deps.resolve ?? lookupAddresses, signal);
    log.debug('source resolved', { hostname: url.hostname, addresses: addresses.join(', ') });
  }
  enforce(checkAddresses(url, addresses, deps.policy), url, log);
  return addresses;
}

function enforce(decision: Decision, url: URL, log: Logger): void {
  if (decision.allowed) {
    return;
  }
  log.info('source denied', {
    hostname: url.hostname,
    reason: decision.reason,
    range: decision.range,
  });
  throw new ServiceError('url_not_allowed', decision.detail);
}

async function lookupAddresses(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true });
  return results.map((result) => result.address);
}

async function resolveHost(
  hostname: string,
  resolve: (hostname: string) => Promise<string[]>,
  signal: AbortSignal,
): Promise<string[]> {
  let addresses: string[];
  try {
    addresses = await untilAborted(resolve(hostname), signal);
  } catch (error) {
    throw transportError(error, signal, `Could not resolve ${hostname}.`);
  }
  if (addresses.length === 0) {
    throw new ServiceError('upstream_error', `${hostname} resolved to no addresses.`);
  }
  return addresses;
}

async function requestHop(
  url: URL,
  addresses: readonly string[],
  deps: FetcherDeps,
  signal: AbortSignal,
): Promise<Hop> {
  const agent = new Agent({
    // autoSelectFamily makes Node call the lookup with `all` set, which is the only form
    // pinnedLookup answers.
    connect: { lookup: pinnedLookup(url.hostname, addresses), autoSelectFamily: true },
    connectTimeout: deps.limits.fetchConnectTimeoutMs,
  });
  // undici's types omit maxRedirections, though its request core still accepts 0 and rejects
  // anything else, so the options are built apart from the call. 0 states here that no
  // dispatcher may follow a Location the policy has not checked.
  const options = {
    dispatcher: agent,
    signal,
    maxRedirections: 0,
    headers: {
      'user-agent': `image-service/${deps.serviceVersion}`,
      accept: ACCEPT,
      'accept-encoding': 'identity',
      [LOOP_MARKER_HEADER]: '1',
    },
  };
  // The request's signal does not interrupt a connection attempt in progress, so the deadline
  // destroys the agent, and with it any socket still connecting.
  const onDeadline = (): void => {
    void agent.destroy();
  };
  signal.addEventListener('abort', onDeadline, { once: true });
  try {
    signal.throwIfAborted();
    return await readResponse(url, await request(url, options), deps.limits.maxSourceBytes);
  } catch (error) {
    throw transportError(error, signal, 'The source could not be reached.');
  } finally {
    signal.removeEventListener('abort', onDeadline);
    // destroy rather than close: close waits for in-flight requests, and a hop that ended
    // without reading its body must not wait on the upstream. It also ends that body.
    await agent.destroy();
  }
}

// dns.lookup cannot be cancelled, so the deadline is kept by no longer waiting for it.
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error('Resolution outlasted the fetch budget.', { cause: signal.reason }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function pinnedLookup(hostname: string, addresses: readonly string[]): LookupFunction {
  const pinned = addresses.map((address) => ({ address, family: isIP(address) }));
  return (requested, _options, callback) => {
    if (requested === hostname) {
      callback(null, pinned);
    } else {
      callback(new Error(`No validated addresses for ${requested}.`), []);
    }
  };
}

async function readResponse(
  url: URL,
  response: Dispatcher.ResponseData,
  maxBytes: number,
): Promise<Hop> {
  const { statusCode: status, headers } = response;
  if (REDIRECT_STATUSES.has(status)) {
    const location =
      typeof headers.location === 'string' ? URL.parse(headers.location, url.href) : null;
    if (location === null) {
      throw new ServiceError(
        'upstream_error',
        `The source redirected with status ${String(status)} but no usable Location.`,
        { upstreamStatus: status },
      );
    }
    return { kind: 'redirect', location };
  }
  if (status < 200 || status > 299) {
    throw new ServiceError(
      'upstream_error',
      `The source responded with status ${String(status)}.`,
      {
        upstreamStatus: status,
      },
    );
  }
  const encoding = headers['content-encoding'];
  if (encoding !== undefined && String(encoding).toLowerCase() !== 'identity') {
    throw new ServiceError(
      'upstream_error',
      `The source sent Content-Encoding ${String(encoding)}; only identity is accepted.`,
    );
  }
  const length = headers['content-length'];
  if (typeof length === 'string' && Number(length) > maxBytes) {
    throw tooLarge(maxBytes);
  }
  const { etag, 'last-modified': lastModified } = headers;
  return {
    kind: 'body',
    status,
    bytes: await readCapped(response.body, maxBytes),
    upstream: {
      ...(typeof etag === 'string' && { etag }),
      ...(typeof lastModified === 'string' && { lastModified }),
    },
  };
}

async function readCapped(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of body) {
    received += chunk.byteLength;
    if (received > maxBytes) {
      throw tooLarge(maxBytes);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, received);
}

function tooLarge(maxBytes: number): ServiceError {
  return new ServiceError('source_too_large', `The source exceeds ${String(maxBytes)} bytes.`);
}

function transportError(error: unknown, signal: AbortSignal, detail: string): ServiceError {
  if (error instanceof ServiceError) {
    return error;
  }
  if (signal.aborted) {
    return new ServiceError(
      'upstream_timeout',
      'The source did not respond within the fetch budget.',
      {},
      { cause: error },
    );
  }
  return new ServiceError('upstream_error', detail, {}, { cause: error });
}
