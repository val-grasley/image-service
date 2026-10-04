import { resolveObjectURL } from 'node:buffer';
import {
  ImageClient,
  processUrl,
  type ProblemDetails,
  type ProcessParams,
  type SourceInfo,
} from '@image-service/sdk';
import { afterEach, assert, describe, expect, it } from 'vitest';
import { paramsFromForm, run } from './api.ts';
import { initialState, type Event, type Form } from './state.ts';

describe('paramsFromForm', () => {
  const cases: { name: string; form: Form; expected: ProcessParams }[] = [
    {
      name: 'omits every blank field',
      form: { ...initialState.form, url: 'https://src.example/cat.jpg' },
      expected: { url: 'https://src.example/cat.jpg' },
    },
    {
      name: 'parses the numeric fields and passes crop and format through',
      form: {
        url: 'https://src.example/cat.jpg',
        width: '300',
        height: '200',
        crop: 'pad',
        format: 'avif',
        quality: '70',
      },
      expected: {
        url: 'https://src.example/cat.jpg',
        width: 300,
        height: 200,
        crop: 'pad',
        format: 'avif',
        quality: 70,
      },
    },
    {
      name: 'passes out-of-range numbers through for the service to reject',
      form: {
        ...initialState.form,
        url: 'https://src.example/cat.jpg',
        width: '0',
        quality: '12.5',
      },
      expected: { url: 'https://src.example/cat.jpg', width: 0, quality: 12.5 },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(paramsFromForm(c.form)).toEqual(c.expected);
    });
  }
});

describe('run', () => {
  const base = 'http://localhost:3000';
  const form: Form = { ...initialState.form, url: 'https://src.example/cat.jpg', format: 'png' };
  const requestUrl = processUrl(base, paramsFromForm(form));
  const imageBytes = new Uint8Array([137, 80, 78, 71]);
  const sourceInfo: SourceInfo = {
    url: form.url,
    finalUrl: form.url,
    format: 'jpeg',
    width: 640,
    height: 480,
    bytes: 51200,
    pages: 1,
  };
  const blocked: ProblemDetails = {
    type: '/docs#error-url_not_allowed',
    title: 'URL not allowed',
    status: 403,
    detail: 'Host resolves to a private network address.',
    code: 'url_not_allowed',
    requestId: 'req-1',
  };

  const image = () =>
    new Response(imageBytes, {
      headers: {
        'Content-Type': 'image/png',
        ETag: '"v1-abc"',
        'X-Image-Width': '640',
        'X-Image-Height': '480',
        'X-Image-Format': 'png',
        'X-Result-Cache': 'miss',
        'X-Request-Id': 'req-2',
      },
    });
  const info = () => Response.json(sourceInfo);
  const problem = () =>
    new Response(JSON.stringify(blocked), {
      status: 403,
      headers: { 'Content-Type': 'application/problem+json' },
    });
  const unreachable = () => Promise.reject(new TypeError('Failed to fetch'));

  function clientAnswering(answers: {
    info: () => Response | Promise<Response>;
    process: () => Response | Promise<Response>;
  }): ImageClient {
    return new ImageClient(base, {
      fetch: (input: RequestInfo | URL) =>
        Promise.resolve(
          input instanceof URL && input.pathname === '/info' ? answers.info() : answers.process(),
        ),
    });
  }

  const objectUrls: string[] = [];
  afterEach(() => {
    for (const url of objectUrls.splice(0)) URL.revokeObjectURL(url);
  });

  async function runWith(client: ImageClient): Promise<Event> {
    const event = await run(client, form, requestUrl, new AbortController().signal);
    if (event.type === 'resolved') objectUrls.push(event.objectUrl);
    return event;
  }

  it('resolves with the source info, the result, and an object URL of the bytes', async () => {
    const event = await runWith(clientAnswering({ info, process: image }));
    expect(event).toMatchObject({
      type: 'resolved',
      requestUrl,
      source: sourceInfo,
      processed: { format: 'png', width: 640, height: 480, bytes: imageBytes },
    });
    assert(event.type === 'resolved');
    const blob = resolveObjectURL(event.objectUrl);
    expect(blob?.type).toBe('image/png');
    expect(await blob?.bytes()).toEqual(imageBytes);
  });

  it('resolves with the problem as the source when only /info fails', async () => {
    const event = await runWith(clientAnswering({ info: problem, process: image }));
    expect(event).toMatchObject({
      type: 'resolved',
      source: { kind: 'source-error', problem: blocked },
    });
  });

  it('fails with the problem when /process fails', async () => {
    const event = await runWith(clientAnswering({ info, process: problem }));
    expect(event).toEqual({ type: 'failed', requestUrl, problem: blocked });
  });

  it('fails with a transport failure when /process gets no response', async () => {
    const event = await runWith(clientAnswering({ info, process: unreachable }));
    expect(event).toEqual({
      type: 'failed',
      requestUrl,
      problem: { kind: 'transport', message: 'The request to the image service failed.' },
    });
  });

  it('fails with a transport failure when /info gets no response', async () => {
    const event = await runWith(clientAnswering({ info: unreachable, process: image }));
    expect(event).toEqual({
      type: 'failed',
      requestUrl,
      problem: { kind: 'transport', message: 'The request to the image service failed.' },
    });
  });
});
