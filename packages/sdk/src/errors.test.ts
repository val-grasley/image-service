import { describe, expect, it } from 'vitest';
import { ImageApiError, ImageApiTransportError, type ProblemDetails } from './index.ts';

const problem: ProblemDetails = {
  type: '/docs#error-upstream_error',
  title: 'Upstream error',
  status: 502,
  detail: 'The source server answered 404.',
  code: 'upstream_error',
  requestId: 'req-1',
  upstreamStatus: 404,
};

describe('ImageApiError', () => {
  it('exposes the code, status, and request ID of its problem', () => {
    const error = new ImageApiError(problem);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ImageApiError');
    expect(error.problem).toBe(problem);
    expect([error.code, error.status, error.requestId]).toEqual(['upstream_error', 502, 'req-1']);
  });

  it('uses the detail as its message', () => {
    expect(new ImageApiError(problem).message).toBe('The source server answered 404.');
  });

  it('falls back to the title when the detail is empty', () => {
    const error = new ImageApiError({
      ...problem,
      code: 'internal_error',
      title: 'Internal error',
      status: 500,
      detail: '',
    });
    expect(error.message).toBe('Internal error');
  });

  it('keeps the cause it was given', () => {
    const cause = new SyntaxError('bad json');
    expect(new ImageApiError(problem, { cause }).cause).toBe(cause);
  });
});

describe('ImageApiTransportError', () => {
  it('is an Error that keeps its cause', () => {
    const cause = new TypeError('fetch failed');
    const error = new ImageApiTransportError('Request to the image service failed.', { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ImageApiTransportError');
    expect(error.cause).toBe(cause);
  });
});
