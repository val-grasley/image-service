# Design: UI

`apps/web`: one page, vanilla TypeScript bundled by esbuild, no framework (decision 6). It
consumes the API through `@image-service/sdk` only. This document fixes the state model,
the render contract, and the build output.

## State

```ts
type Form = { url: string; width: string; height: string; crop: CropMode | ''; format: OutputFormat | ''; quality: string };

type SourceError = { kind: 'source-error'; problem: ProblemDetails };
type TransportFailure = { kind: 'transport'; message: string };

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading'; requestUrl: URL; controller: AbortController }
  | { kind: 'success'; requestUrl: URL; source: SourceInfo | SourceError; processed: ProcessResult; objectUrl: string }
  | { kind: 'error'; requestUrl: URL | undefined; problem: ProblemDetails | TransportFailure };

type State = { form: Form; phase: Phase; copied: 'url' | 'curl' | undefined };

type Event =
  | { type: 'field'; name: keyof Form; value: string }
  | { type: 'submit'; requestUrl: URL; controller: AbortController }
  | { type: 'resolved'; requestUrl: URL; source: SourceInfo | SourceError; processed: ProcessResult; objectUrl: string }
  | { type: 'failed'; requestUrl: URL | undefined; problem: ProblemDetails | TransportFailure }
  | { type: 'copied'; what: 'url' | 'curl' }
  | { type: 'copy-cleared' };

function reduce(state: State, event: Event): State;   // pure
```

Form fields are strings because they mirror inputs; the SDK call converts. `reduce` has no
side effects: `main.ts` creates the `AbortController` and the request URL when it
dispatches `submit`, and after every reduction it compares the old and new phase, aborting
a replaced `loading` controller and revoking a replaced `success` object URL. `api.ts`
creates the object URL from the processed bytes and the `resolved` event carries it.

## Modules

- `state.ts`: the types above and `reduce`.
- `api.ts`: `paramsFromForm(form): ProcessParams` is the one place the form is converted;
  `main.ts` uses it to build the request URL on `submit`, and `run(form, signal):
  Promise<Event>` uses it, then calls
  `client.info` and `client.process` in parallel, and returns a `resolved` or `failed`
  event. The source info failing while the processed image succeeds is `resolved` with
  `source` set to a `SourceError` carrying the problem, so the page still shows the result.
- `render.ts`: `render(state, root, dispatch)`. Rebuilds the dynamic regions and attaches
  listeners that call `dispatch`; `main.ts` never holds element references. Elements are
  built with a small `el(tag, attrs, children)` helper in the same file; all text goes
  through `textContent` or attribute setters.
- `main.ts`: creates the client from `location.origin`, holds the state, and runs the loop:
  `dispatch(event)` reduces, performs the abort and revoke described above, renders, and
  if the new phase is `loading`, calls `api.run` with the controller's signal and
  dispatches its result.

## Page

Three regions under a heading:

1. **Form.** Source URL (required), width, height, crop (select with a blank "default: fit"
   option), format (select with blank "same as source"), quality. Submit on button or Enter.
   Field errors from a problem's `errors` appear beside the matching input.
2. **Request.** The exact request URL from `processUrl` and the curl line from `curlFor`,
   each with a copy button that shows "Copied" for two seconds. Shown from the first submit
   on, including in the error state when a URL was built.
3. **Images.** Two panels, original and processed. Each shows the image, then dimensions,
   format, and size in a definition list. The original is an `img` pointing at the source
   URL, with metadata from `/info`; if `/info` failed, its problem is shown in the panel.
   The processed image is the object URL of the SDK's bytes, with metadata from the result
   and the size from `bytes.byteLength`. The processed panel shows a loading indicator
   during `loading` and the problem (`title`, `detail`, `code`, `requestId`) during `error`.

Empty state: the panels show short guidance text and no images. Nothing is hidden by
default; disabled elements stay visible.

## Accessibility and layout

Every input has a `label`. The error and copied regions are `aria-live="polite"`. The
layout is a single column at 360 px and two columns for the panels above 800 px, in
`styles.css`, no framework. Images use `max-width: 100%`.

## Build

`build.ts` runs esbuild with `bundle: true`, `format: 'esm'`, `target: 'es2022'`,
`minify` in production, `sourcemap` in dev, entry `src/main.ts`, outfile
`dist/assets/app.js`; copies `index.html` and `favicon.ico` to `dist/` and `styles.css` to
`dist/assets/`. `--watch` rebuilds on change. The API serves `dist/` locally with the same
paths CloudFront routes to S3.

## Tests

Unit: `reduce` over each event from each phase; and `main.ts`'s phase comparison, which is
a pure function `effectsFor(before, after)` returning the controller to abort and the URL to
revoke. The DOM is covered by the end-to-end suite
(`e2e/`), which exercises every state in the list above through the real API and the fake
upstream.
