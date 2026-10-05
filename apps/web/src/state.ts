import {
  CROP_MODES,
  OUTPUT_FORMATS,
  type CropMode,
  type OutputFormat,
  type ProblemDetails,
  type ProcessResult,
  type SourceInfo,
} from '@image-service/sdk';

export type Form = {
  url: string;
  width: string;
  height: string;
  crop: CropMode | '';
  format: OutputFormat | '';
  quality: string;
};

export type SourceError = { kind: 'source-error'; problem: ProblemDetails };
export type TransportFailure = { kind: 'transport'; message: string };

export type Phase =
  | { kind: 'idle' }
  | { kind: 'loading'; requestUrl: URL; controller: AbortController }
  | {
      kind: 'success';
      requestUrl: URL;
      source: SourceInfo | SourceError;
      processed: ProcessResult;
      objectUrl: string;
    }
  | { kind: 'error'; requestUrl: URL; problem: ProblemDetails | TransportFailure };

export type Copyable = 'url' | 'curl';

export type State = {
  form: Form;
  phase: Phase;
  copy: { what: Copyable; outcome: 'copied' | 'failed' } | undefined;
};

export type Event =
  | { type: 'field'; name: keyof Form; value: string }
  | { type: 'submit'; requestUrl: URL; controller: AbortController }
  | {
      type: 'resolved';
      requestUrl: URL;
      source: SourceInfo | SourceError;
      processed: ProcessResult;
      objectUrl: string;
    }
  | { type: 'failed'; requestUrl: URL; problem: ProblemDetails | TransportFailure }
  | { type: 'copied'; what: Copyable }
  | { type: 'copy-failed'; what: Copyable }
  | { type: 'copy-cleared' };

export const initialState: State = {
  form: { url: '', width: '', height: '', crop: '', format: '', quality: '' },
  phase: { kind: 'idle' },
  copy: undefined,
};

export function reduce(state: State, event: Event): State {
  switch (event.type) {
    case 'field':
      return { ...state, form: withField(state.form, event.name, event.value) };
    case 'submit':
      return {
        ...state,
        phase: { kind: 'loading', requestUrl: event.requestUrl, controller: event.controller },
        copy: undefined,
      };
    case 'resolved':
      if (!awaits(state.phase, event.requestUrl)) return state;
      return {
        ...state,
        phase: {
          kind: 'success',
          requestUrl: event.requestUrl,
          source: event.source,
          processed: event.processed,
          objectUrl: event.objectUrl,
        },
      };
    case 'failed':
      if (!awaits(state.phase, event.requestUrl)) return state;
      return {
        ...state,
        phase: { kind: 'error', requestUrl: event.requestUrl, problem: event.problem },
      };
    case 'copied':
      return { ...state, copy: { what: event.what, outcome: 'copied' } };
    case 'copy-failed':
      return { ...state, copy: { what: event.what, outcome: 'failed' } };
    case 'copy-cleared':
      return { ...state, copy: undefined };
    default:
      return event satisfies never;
  }
}

// Identity, not `href`: a resubmission of the same parameters builds an equal URL, and the
// abort failure of the request it replaced must not settle it.
function awaits(phase: Phase, requestUrl: URL): boolean {
  return phase.kind === 'loading' && phase.requestUrl === requestUrl;
}

function withField(form: Form, name: keyof Form, value: string): Form {
  switch (name) {
    case 'crop':
      return { ...form, crop: CROP_MODES.find((mode) => mode === value) ?? '' };
    case 'format':
      return { ...form, format: OUTPUT_FORMATS.find((format) => format === value) ?? '' };
    case 'url':
    case 'width':
    case 'height':
    case 'quality':
      return { ...form, [name]: value };
    default:
      return name satisfies never;
  }
}

export function effectsFor(
  before: Phase,
  after: Phase,
): { abort: AbortController | undefined; revoke: string | undefined } {
  if (before === after) return { abort: undefined, revoke: undefined };
  return {
    // Leaving a loading phase aborts its controller. On a resubmission that cancels the
    // replaced request; on a failure, the other call still in flight; after a success both
    // calls have settled and the abort does nothing.
    abort: before.kind === 'loading' ? before.controller : undefined,
    revoke: before.kind === 'success' ? before.objectUrl : undefined,
  };
}
