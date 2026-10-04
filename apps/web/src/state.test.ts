import { processUrl, type ProblemDetails, type ProcessResult } from '@image-service/sdk';
import { describe, expect, it } from 'vitest';
import {
  effectsFor,
  initialState,
  reduce,
  type Event,
  type Phase,
  type SourceError,
  type State,
} from './state.ts';

const base = 'http://localhost:3000';
const requestUrl = processUrl(base, { url: 'https://src.example/cat.jpg', width: 300 });
const nextUrl = processUrl(base, { url: 'https://src.example/cat.jpg', width: 200 });
const controller = new AbortController();
const nextController = new AbortController();

const processed: ProcessResult = {
  bytes: new Uint8Array([1, 2, 3]),
  contentType: 'image/webp',
  format: 'webp',
  width: 300,
  height: 200,
  etag: '"v1-abc"',
  requestId: 'req-1',
  resultCache: 'miss',
};

const sourceError: SourceError = {
  kind: 'source-error',
  problem: {
    type: '/docs#error-upstream_timeout',
    title: 'Upstream timeout',
    status: 504,
    detail: 'The source did not answer in time.',
    code: 'upstream_timeout',
    requestId: 'req-2',
  },
};

const invalidWidth: ProblemDetails = {
  type: '/docs#error-invalid_parameter',
  title: 'Invalid parameter',
  status: 400,
  detail: 'One or more query parameters are invalid.',
  code: 'invalid_parameter',
  requestId: 'req-3',
  errors: [{ field: 'width', message: 'must be at least 1' }],
};

const idle: Phase = { kind: 'idle' };
const loading: Phase = { kind: 'loading', requestUrl, controller };
const success: Phase = {
  kind: 'success',
  requestUrl,
  source: sourceError,
  processed,
  objectUrl: 'blob:http://localhost:3000/1',
};
const error: Phase = { kind: 'error', requestUrl, problem: invalidWidth };

function resolvedFor(url: URL): Event {
  return {
    type: 'resolved',
    requestUrl: url,
    source: sourceError,
    processed,
    objectUrl: 'blob:http://localhost:3000/2',
  };
}

function failedFor(url: URL): Event {
  return { type: 'failed', requestUrl: url, problem: invalidWidth };
}

function stateIn(phase: Phase): State {
  return { ...initialState, phase, copied: 'url' };
}

describe('reduce', () => {
  for (const phase of [idle, loading, success, error]) {
    describe(`from ${phase.kind}`, () => {
      it('sets a form field and keeps the phase object', () => {
        const state = stateIn(phase);
        const next = reduce(state, { type: 'field', name: 'width', value: '300' });
        expect(next).toEqual({ ...state, form: { ...state.form, width: '300' } });
        expect(next.phase).toBe(phase);
      });

      it('starts loading the submitted request and clears the copied mark', () => {
        const next = reduce(stateIn(phase), {
          type: 'submit',
          requestUrl: nextUrl,
          controller: nextController,
        });
        expect(next).toEqual({
          ...initialState,
          phase: { kind: 'loading', requestUrl: nextUrl, controller: nextController },
          copied: undefined,
        });
        // Every AbortController is structurally equal, so the controller is checked by identity.
        expect(next.phase.kind === 'loading' && next.phase.controller).toBe(nextController);
      });

      it('sets the copied mark and clears it, keeping the phase object', () => {
        const state = { ...stateIn(phase), copied: undefined };
        const copied = reduce(state, { type: 'copied', what: 'curl' });
        expect(copied).toEqual({ ...state, copied: 'curl' });
        expect(copied.phase).toBe(phase);
        const cleared = reduce(copied, { type: 'copy-cleared' });
        expect(cleared).toEqual(state);
        expect(cleared.phase).toBe(phase);
      });

      if (phase.kind !== 'loading') {
        it('ignores results when no request is loading', () => {
          const state = stateIn(phase);
          expect(reduce(state, resolvedFor(requestUrl))).toBe(state);
          expect(reduce(state, failedFor(requestUrl))).toBe(state);
        });
      }
    });
  }

  describe('from loading', () => {
    it('succeeds with the result of the loading request', () => {
      expect(reduce(stateIn(loading), resolvedFor(requestUrl))).toEqual(
        stateIn({
          kind: 'success',
          requestUrl,
          source: sourceError,
          processed,
          objectUrl: 'blob:http://localhost:3000/2',
        }),
      );
    });

    it('fails with the problem of the loading request', () => {
      expect(reduce(stateIn(loading), failedFor(requestUrl))).toEqual(
        stateIn({ kind: 'error', requestUrl, problem: invalidWidth }),
      );
    });

    it('ignores results of a replaced request, even one with an equal URL', () => {
      const state = stateIn(loading);
      const equalUrl = new URL(requestUrl.href);
      expect(reduce(state, resolvedFor(equalUrl))).toBe(state);
      expect(reduce(state, failedFor(equalUrl))).toBe(state);
      expect(reduce(state, failedFor(nextUrl))).toBe(state);
    });
  });

  it('keeps a known crop mode and format and blanks unknown ones', () => {
    const known = reduce(reduce(initialState, { type: 'field', name: 'crop', value: 'fill' }), {
      type: 'field',
      name: 'format',
      value: 'avif',
    });
    expect(known.form).toEqual({ ...initialState.form, crop: 'fill', format: 'avif' });
    const unknown = reduce(reduce(known, { type: 'field', name: 'crop', value: 'stretch' }), {
      type: 'field',
      name: 'format',
      value: 'gif',
    });
    expect(unknown.form).toEqual(initialState.form);
  });
});

describe('effectsFor', () => {
  const cases: {
    name: string;
    before: Phase;
    after: Phase;
    expected: ReturnType<typeof effectsFor>;
  }[] = [
    ...[idle, loading, success, error].map((phase) => ({
      name: `does nothing while the ${phase.kind} phase is kept`,
      before: phase,
      after: phase,
      expected: { abort: undefined, revoke: undefined },
    })),
    {
      name: 'does nothing when the first request starts',
      before: idle,
      after: { kind: 'loading', requestUrl: nextUrl, controller: nextController },
      expected: { abort: undefined, revoke: undefined },
    },
    {
      name: 'aborts the loading request a resubmission replaces',
      before: loading,
      after: { kind: 'loading', requestUrl: nextUrl, controller: nextController },
      expected: { abort: controller, revoke: undefined },
    },
    {
      name: 'returns the controller of a succeeded request, whose abort does nothing',
      before: loading,
      after: success,
      expected: { abort: controller, revoke: undefined },
    },
    {
      name: 'aborts a failed request so its other call stops',
      before: loading,
      after: error,
      expected: { abort: controller, revoke: undefined },
    },
    {
      name: 'revokes the object URL of a success a new request replaces',
      before: success,
      after: { kind: 'loading', requestUrl: nextUrl, controller: nextController },
      expected: { abort: undefined, revoke: 'blob:http://localhost:3000/1' },
    },
    {
      name: 'does nothing when a request replaces an error',
      before: error,
      after: { kind: 'loading', requestUrl: nextUrl, controller: nextController },
      expected: { abort: undefined, revoke: undefined },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const effects = effectsFor(c.before, c.after);
      expect(effects.abort).toBe(c.expected.abort);
      expect(effects.revoke).toBe(c.expected.revoke);
    });
  }
});
