import { describe, expect, it } from 'vitest';
import { ServiceError } from './errors.ts';

describe('ServiceError', () => {
  it('carries its code and detail, and uses the detail as its message', () => {
    const error = new ServiceError('url_not_allowed', 'Host resolves to a private address.');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ServiceError');
    expect([error.code, error.detail, error.message]).toEqual([
      'url_not_allowed',
      'Host resolves to a private address.',
      'Host resolves to a private address.',
    ]);
  });

  it('carries the field errors, upstream status, and rate-limit decision it was given', () => {
    const fields = [{ field: 'width', message: 'must be an integer between 1 and 4096' }];
    const rateLimit = { allowed: false, limit: 60, remaining: 0, resetSeconds: 12 };
    const error = new ServiceError('invalid_parameter', 'Invalid query.', {
      fields,
      upstreamStatus: 404,
      rateLimit,
    });
    expect(error.fields).toBe(fields);
    expect(error.upstreamStatus).toBe(404);
    expect(error.rateLimit).toBe(rateLimit);
  });

  it('leaves the extras undefined when none are given', () => {
    const error = new ServiceError('not_found', 'No such path.');
    expect([error.fields, error.upstreamStatus, error.rateLimit]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('preserves the cause', () => {
    const cause = new Error('socket hang up');
    expect(new ServiceError('upstream_error', 'Upstream failed.', {}, { cause }).cause).toBe(cause);
  });
});
