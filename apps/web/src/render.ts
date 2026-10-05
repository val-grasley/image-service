import {
  CROP_MODES,
  OUTPUT_FORMATS,
  curlFor,
  type ProblemDetails,
  type SourceInfo,
} from '@image-service/sdk';
import type {
  Copyable,
  Event,
  Form,
  Phase,
  SourceError,
  State,
  TransportFailure,
} from './state.ts';

export type Dispatch = (event: Event | { type: 'submit-requested' }) => void;

const COPY_STATUS_MS = 2000;

const copyStatusText = { copied: 'Copied', failed: 'Copy failed; select the text instead' };

// Built once: rebuilding the form or the copy buttons on every update would take the focus
// away from the input being typed in or the button just pressed.
export function mount(root: HTMLElement, dispatch: Dispatch): (state: State) => void {
  const controls: [keyof Form, string, HTMLInputElement | HTMLSelectElement][] = [
    ['url', 'Source URL', el('input', { type: 'url', required: '' })],
    ['width', 'Width', el('input', { type: 'number' })],
    ['height', 'Height', el('input', { type: 'number' })],
    ['crop', 'Crop', select('default: fit', CROP_MODES)],
    ['format', 'Format', select('same as source', OUTPUT_FORMATS)],
    ['quality', 'Quality', el('input', { type: 'number' })],
  ];
  const fields = controls.map(([name, label, control]) => {
    const id = `field-${name}`;
    const error = el('span', { id: `${id}-error`, class: 'field-error' });
    control.id = id;
    control.name = name;
    control.setAttribute('aria-describedby', error.id);
    control.addEventListener('input', () => {
      dispatch({ type: 'field', name, value: control.value });
    });
    const row = el('div', { class: 'field' }, [el('label', { for: id }, label), control, error]);
    return { name, control, error, row };
  });
  const formElement = el('form', {}, [
    ...fields.map((field) => field.row),
    el('button', { type: 'submit' }, 'Process'),
  ]);
  formElement.addEventListener('submit', (submitted) => {
    submitted.preventDefault();
    dispatch({ type: 'submit-requested' });
  });

  // One timer for both buttons, so a second copy keeps its indicator for the full two seconds.
  let clearing: ReturnType<typeof setTimeout> | undefined;
  const copyTargets: [Copyable, string][] = [
    ['url', 'request URL'],
    ['curl', 'curl command'],
  ];
  const copyRows = copyTargets.map(([what, label]) => {
    const text = el('code');
    const status = el('span', {
      id: `copy-${what}-status`,
      'aria-live': 'polite',
      class: 'copied',
    });
    const button = el('button', { type: 'button', 'aria-describedby': status.id }, `Copy ${label}`);
    button.addEventListener('click', () => {
      // The Clipboard API exists only in a secure context, so the dev server reached over a
      // LAN address has no navigator.clipboard, whatever its type says.
      const written =
        'clipboard' in navigator
          ? navigator.clipboard.writeText(text.textContent)
          : Promise.reject(new Error('The Clipboard API needs a secure context.'));
      void written
        .then(
          (): Event => ({ type: 'copied', what }),
          (): Event => ({ type: 'copy-failed', what }),
        )
        .then((event) => {
          clearTimeout(clearing);
          dispatch(event);
          clearing = setTimeout(() => {
            dispatch({ type: 'copy-cleared' });
          }, COPY_STATUS_MS);
        });
    });
    const row = el('div', { class: 'copy-row' }, [text, el('div', {}, [button, status])]);
    return { what, text, button, status, row };
  });
  const requestHint = el('p');

  const original = el('div');
  const processed = el('div', { 'aria-live': 'polite' });

  root.replaceChildren(
    el('main', {}, [
      el('h1', {}, 'Image service'),
      formElement,
      el('section', { 'aria-labelledby': 'request-title' }, [
        el('h2', { id: 'request-title' }, 'Request'),
        requestHint,
        ...copyRows.map((row) => row.row),
      ]),
      el('section', { 'aria-labelledby': 'images-title' }, [
        el('h2', { id: 'images-title' }, 'Images'),
        el('div', { class: 'panels' }, [
          el('section', { class: 'panel', 'aria-labelledby': 'original-title' }, [
            el('h3', { id: 'original-title' }, 'Original'),
            original,
          ]),
          el('section', { class: 'panel', 'aria-labelledby': 'processed-title' }, [
            el('h3', { id: 'processed-title' }, 'Processed'),
            processed,
          ]),
        ]),
      ]),
    ]),
  );

  let renderedPhase: Phase | undefined;
  return (state) => {
    for (const row of copyRows) {
      row.status.textContent =
        state.copy?.what === row.what ? copyStatusText[state.copy.outcome] : '';
    }
    // Typing and copying keep the phase object, so the regions derived from it, images
    // included, are rebuilt only when a request starts or settles.
    if (state.phase === renderedPhase) return;
    renderedPhase = state.phase;

    const requestUrl = state.phase.kind === 'idle' ? undefined : state.phase.requestUrl;
    const texts: Record<Copyable, string> =
      requestUrl === undefined
        ? { url: '', curl: '' }
        : { url: requestUrl.href, curl: curlFor(requestUrl) };
    requestHint.textContent =
      requestUrl === undefined
        ? 'The request URL and curl command appear here once you submit.'
        : '';
    for (const row of copyRows) {
      row.text.textContent = texts[row.what];
      row.button.disabled = requestUrl === undefined;
    }

    const problem = state.phase.kind === 'error' ? state.phase.problem : undefined;
    const fieldErrors = problem === undefined || 'kind' in problem ? [] : (problem.errors ?? []);
    for (const field of fields) {
      const message = fieldErrors
        .filter((error) => error.field === field.name)
        .map((error) => error.message)
        .join(' ');
      field.error.textContent = message;
      field.control.setAttribute('aria-invalid', String(message !== ''));
    }

    const [originalContent, processedContent] = panels(state.phase);
    original.replaceChildren(...originalContent);
    processed.replaceChildren(...processedContent);
  };
}

function panels(phase: Phase): [original: Node[], processed: Node[]] {
  switch (phase.kind) {
    case 'idle':
      return [
        [el('p', {}, 'The source image and its metadata appear here.')],
        [el('p', {}, 'The processed image and its metadata appear here.')],
      ];
    case 'loading':
      return [[el('p', {}, 'Loading…')], [el('p', {}, 'Processing…')]];
    case 'success':
      return [
        sourcePanel(phase.requestUrl, phase.source),
        [
          el('img', { src: phase.objectUrl, alt: 'Processed image' }),
          metadata(
            phase.processed.width,
            phase.processed.height,
            phase.processed.format,
            phase.processed.bytes.byteLength,
          ),
        ],
      ];
    case 'error':
      return [[el('p', {}, 'No source image for this request.')], problemView(phase.problem)];
    default:
      return phase satisfies never;
  }
}

function sourcePanel(requestUrl: URL, source: SourceInfo | SourceError): Node[] {
  const details =
    'kind' in source
      ? problemView(source.problem)
      : [metadata(source.width, source.height, source.format, source.bytes)];
  const sourceUrl = requestUrl.searchParams.get('url');
  if (sourceUrl === null) return details;
  const image = el('img', { src: sourceUrl, alt: 'Original image' });
  // The browser loads the original from its own URL, which a hotlink rule, a mixed-content
  // block, or a host the browser cannot reach may refuse although the service fetched it.
  image.addEventListener('error', () => {
    image.replaceWith(
      el(
        'p',
        {},
        'The browser could not load the original image directly; the details below come from the service.',
      ),
    );
  });
  return [image, ...details];
}

function metadata(width: number, height: number, format: string, size: number): HTMLElement {
  return el('dl', {}, [
    el('dt', {}, 'Dimensions'),
    el('dd', {}, `${String(width)} × ${String(height)}`),
    el('dt', {}, 'Format'),
    el('dd', {}, format),
    el('dt', {}, 'Size'),
    el('dd', {}, `${size.toLocaleString()} bytes`),
  ]);
}

function problemView(problem: ProblemDetails | TransportFailure): Node[] {
  if ('kind' in problem) {
    return [
      el('p', { class: 'problem-title' }, 'The request did not complete.'),
      el('p', {}, problem.message),
    ];
  }
  return [
    el('p', { class: 'problem-title' }, problem.title),
    el('p', {}, problem.detail),
    el('dl', {}, [
      el('dt', {}, 'Code'),
      el('dd', {}, problem.code),
      el('dt', {}, 'Request ID'),
      el('dd', {}, problem.requestId),
    ]),
  ];
}

function select(blank: string, options: readonly string[]): HTMLSelectElement {
  return el('select', {}, [
    el('option', { value: '' }, blank),
    ...options.map((option) => el('option', { value: option }, option)),
  ]);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  content: string | Node[] = [],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  if (typeof content === 'string') element.textContent = content;
  else element.append(...content);
  return element;
}
