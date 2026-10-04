import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ImageApiError,
  ImageApiTransportError,
  ImageClient,
  infoUrl,
  processUrl,
  type ProblemDetails,
  type ProcessParams,
  type SourceInfo,
} from './index.ts';

const base = 'https://img.example';
const params: ProcessParams = { url: 'https://src.example/cat.jpg', width: 300, format: 'webp' };
const body = new Uint8Array([1, 2, 3, 4]);

const imageHeaders: Record<string, string> = {
  'Content-Type': 'image/webp',
  ETag: '"v1-abc"',
  'X-Image-Width': '300',
  'X-Image-Height': '200',
  'X-Image-Format': 'webp',
  'X-Result-Cache': 'hit',
  'X-Request-Id': 'req-1',
};

const invalidHeaders: [name: string, value: string][] = [
  ['X-Image-Width', 'wide'],
  ['X-Image-Width', '12.5'],
  ['X-Image-Height', '0'],
  ['X-Image-Format', 'gif'],
  ['X-Result-Cache', 'stale'],
  ['ETag', ''],
];

const sourceInfo: SourceInfo = {
  url: 'https://src.example/cat.jpg',
  finalUrl: 'https://cdn.src.example/cat.jpg',
  format: 'jpeg',
  width: 640,
  height: 480,
  bytes: 51200,
  pages: 1,
};

const rateLimited: ProblemDetails = {
  type: '/docs#error-rate_limited',
  title: 'Rate limited',
  status: 429,
  detail: 'Too many requests; retry after 12 seconds.',
  code: 'rate_limited',
  requestId: 'req-2',
};

const invalidWidth: ProblemDetails = {
  type: '/docs#error-invalid_parameter',
  title: 'Invalid parameter',
  status: 400,
  detail: 'One or more query parameters are invalid.',
  code: 'invalid_parameter',
  requestId: 'req-3',
  errors: [{ field: 'width', message: 'must be an integer between 1 and 4096' }],
};

function malformedVariants(valid: object): { name: string; body: unknown }[] {
  return Object.entries(valid).flatMap(([key, value]) => [
    {
      name: `without ${key}`,
      body: Object.fromEntries(Object.entries(valid).filter(([other]) => other !== key)),
    },
    {
      name: `with a mistyped ${key}`,
      body: { ...valid, [key]: typeof value === 'number' ? String(value) : 7 },
    },
  ]);
}

const malformedProblems: { name: string; body: unknown }[] = [
  ...malformedVariants(rateLimited),
  { name: 'that is null', body: null },
  { name: 'with a mistyped upstreamStatus', body: { ...rateLimited, upstreamStatus: '502' } },
  {
    name: 'with a field error that is not an object',
    body: { ...invalidWidth, errors: ['width'] },
  },
  ...malformedVariants({ field: 'width', message: 'must be an integer' }).map((variant) => ({
    name: `with a field error ${variant.name}`,
    body: { ...invalidWidth, errors: [variant.body] },
  })),
];

const malformedSourceInfos: { name: string; body: unknown }[] = [
  ...malformedVariants(sourceInfo),
  { name: 'that is null', body: null },
  { name: 'with an unknown format', body: { ...sourceInfo, format: 'bmp' } },
];

function synthesized(status: number, detail: string, requestId: string): ProblemDetails {
  return {
    type: '/docs#error-internal_error',
    title: 'Internal error',
    status,
    detail,
    code: 'internal_error',
    requestId,
  };
}

function problemResponse(text: string, contentType = 'application/problem+json'): Response {
  return new Response(text, {
    status: 400,
    headers: { 'Content-Type': contentType, 'X-Request-Id': 'req-3' },
  });
}

function clientAnswering(answer: () => Promise<Response>) {
  const sent: { input: unknown; init: RequestInit | undefined }[] = [];
  const client = new ImageClient(`${base}/ui/`, {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ input, init });
      return answer();
    },
  });
  return { client, sent };
}

function clientReturning(response: Response): ImageClient {
  return clientAnswering(() => Promise.resolve(response)).client;
}

async function rejectionOf<E>(
  promise: Promise<unknown>,
  type: new (...args: never[]) => E,
): Promise<E> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof type) return error;
    throw error;
  }
  throw new Error(`Expected a rejection with ${type.name}.`);
}

describe('ImageClient.process', () => {
  it('returns the bytes and the metadata from the image headers', async () => {
    const client = clientReturning(new Response(body, { headers: imageHeaders }));
    expect(await client.process(params)).toEqual({
      bytes: body,
      contentType: 'image/webp',
      format: 'webp',
      width: 300,
      height: 200,
      etag: '"v1-abc"',
      requestId: 'req-1',
      resultCache: 'hit',
    });
  });

  it('requests the canonical URL and forwards the signal', async () => {
    const { client, sent } = clientAnswering(() =>
      Promise.resolve(new Response(body, { headers: imageHeaders })),
    );
    const { signal } = new AbortController();
    await client.process(params, { signal });
    expect(sent).toEqual([{ input: processUrl(base, params), init: { signal } }]);
  });

  const errorCases: {
    name: string;
    response: () => Response;
    problem: ProblemDetails;
    cause: unknown;
  }[] = [
    {
      name: 'throws the body of a problem-details response',
      response: () => problemResponse(JSON.stringify(invalidWidth)),
      problem: invalidWidth,
      cause: undefined,
    },
    {
      name: 'reads a problem-details content type that carries parameters',
      response: () =>
        problemResponse(JSON.stringify(rateLimited), 'application/problem+json; charset=utf-8'),
      problem: rateLimited,
      cause: undefined,
    },
    {
      name: 'reads a problem-details content type in any letter case',
      response: () => problemResponse(JSON.stringify(rateLimited), 'Application/Problem+JSON'),
      problem: rateLimited,
      cause: undefined,
    },
    {
      name: 'synthesizes from a content type that only begins with the problem-details type',
      response: () => problemResponse(JSON.stringify(rateLimited), 'application/problem+jsonp'),
      problem: synthesized(400, JSON.stringify(rateLimited), 'req-3'),
      cause: undefined,
    },
    {
      name: 'synthesizes internal_error with the status from a plain-text 429',
      response: () =>
        new Response('Rate Exceeded.', { status: 429, headers: { 'Content-Type': 'text/plain' } }),
      problem: synthesized(429, 'Rate Exceeded.', ''),
      cause: undefined,
    },
    {
      name: 'truncates a non-problem body to 200 characters and keeps the request ID header',
      response: () =>
        new Response('x'.repeat(500), {
          status: 502,
          headers: { 'Content-Type': 'text/html', 'X-Request-Id': 'req-4' },
        }),
      problem: synthesized(502, 'x'.repeat(200), 'req-4'),
      cause: undefined,
    },
    {
      name: 'treats JSON without the problem-details content type as a non-problem body',
      response: () => Response.json(rateLimited, { status: 500 }),
      problem: synthesized(500, JSON.stringify(rateLimited), ''),
      cause: undefined,
    },
    {
      name: 'synthesizes from the text of a problem-details body that is not JSON',
      response: () => problemResponse('{"type":"/docs#error-'),
      problem: synthesized(400, '{"type":"/docs#error-', 'req-3'),
      cause: expect.any(SyntaxError),
    },
    {
      name: 'synthesizes from the text of a problem-details body with an unknown code',
      response: () => problemResponse(JSON.stringify({ ...rateLimited, code: 'teapot' })),
      problem: synthesized(400, JSON.stringify({ ...rateLimited, code: 'teapot' }), 'req-3'),
      cause: undefined,
    },
  ];

  for (const c of errorCases) {
    it(c.name, async () => {
      const error = await rejectionOf(clientReturning(c.response()).process(params), ImageApiError);
      expect([error.code, error.status, error.requestId]).toEqual([
        c.problem.code,
        c.problem.status,
        c.problem.requestId,
      ]);
      expect(error.problem).toEqual(c.problem);
      expect(error.cause).toEqual(c.cause);
    });
  }

  for (const c of malformedProblems) {
    it(`synthesizes from the text of a problem-details body ${c.name}`, async () => {
      const text = JSON.stringify(c.body);
      const response = problemResponse(text);
      const error = await rejectionOf(clientReturning(response).process(params), ImageApiError);
      expect(error.problem).toEqual(synthesized(400, text.slice(0, 200), 'req-3'));
    });
  }

  const headerCases: { name: string; headers: Record<string, string>; problem: ProblemDetails }[] =
    [
      ...Object.keys(imageHeaders).map((name) => ({
        name: `rejects a 2xx without ${name}`,
        headers: Object.fromEntries(Object.entries(imageHeaders).filter(([key]) => key !== name)),
        problem: synthesized(
          200,
          `The response has no valid ${name} header.`,
          name === 'X-Request-Id' ? '' : 'req-1',
        ),
      })),
      ...invalidHeaders.map(([name, value]) => ({
        name: `rejects a 2xx whose ${name} is ${JSON.stringify(value)}`,
        headers: { ...imageHeaders, [name]: value },
        problem: synthesized(200, `The response has no valid ${name} header.`, 'req-1'),
      })),
    ];

  for (const c of headerCases) {
    it(c.name, async () => {
      const response = new Response(body, { headers: c.headers });
      const error = await rejectionOf(clientReturning(response).process(params), ImageApiError);
      expect(error.problem).toEqual(c.problem);
    });
  }

  it('throws a transport error carrying the rejection when fetch fails', async () => {
    const failure = new TypeError('fetch failed');
    const { client } = clientAnswering(() => Promise.reject(failure));
    const error = await rejectionOf(client.process(params), ImageApiTransportError);
    expect(error.cause).toBe(failure);
  });

  it('throws a transport error carrying the failure when the body is cut off', async () => {
    const failure = new TypeError('terminated');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure);
      },
    });
    const client = clientReturning(new Response(stream, { headers: imageHeaders }));
    const error = await rejectionOf(client.process(params), ImageApiTransportError);
    expect(error.cause).toBe(failure);
  });
});

describe('ImageClient.info', () => {
  it('returns the source metadata from the /info URL and forwards the signal', async () => {
    const { client, sent } = clientAnswering(() => Promise.resolve(Response.json(sourceInfo)));
    const { signal } = new AbortController();
    expect(await client.info(sourceInfo.url, { signal })).toEqual(sourceInfo);
    expect(sent).toEqual([{ input: infoUrl(base, sourceInfo.url), init: { signal } }]);
  });

  it('throws the body of a problem-details response', async () => {
    const error = await rejectionOf(
      clientReturning(problemResponse(JSON.stringify(invalidWidth))).info(sourceInfo.url),
      ImageApiError,
    );
    expect(error.problem).toEqual(invalidWidth);
  });

  it('rejects a 2xx body that is not JSON', async () => {
    const response = new Response('<!doctype html>', {
      headers: { 'Content-Type': 'text/html', 'X-Request-Id': 'req-5' },
    });
    const error = await rejectionOf(clientReturning(response).info(sourceInfo.url), ImageApiError);
    expect(error.problem).toEqual(synthesized(200, 'The response body is not JSON.', 'req-5'));
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });

  for (const c of malformedSourceInfos) {
    it(`rejects a 2xx JSON body ${c.name}`, async () => {
      const response = Response.json(c.body);
      const error = await rejectionOf(
        clientReturning(response).info(sourceInfo.url),
        ImageApiError,
      );
      expect(error.problem).toEqual(synthesized(200, 'The response body is not a SourceInfo.', ''));
    });
  }
});

describe('ImageClient fetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to globalThis.fetch', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json(sourceInfo)));
    expect(await new ImageClient(base).info(sourceInfo.url)).toEqual(sourceInfo);
  });

  it('calls fetch without the client as its receiver, as browsers require', async () => {
    const receivers: unknown[] = [];
    const client = new ImageClient(base, {
      fetch: function (this: unknown) {
        receivers.push(this);
        return Promise.resolve(Response.json(sourceInfo));
      },
    });
    await client.info(sourceInfo.url);
    expect(receivers).toEqual([undefined]);
  });
});
