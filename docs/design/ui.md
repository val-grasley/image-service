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
  | { kind: 'error'; requestUrl: URL; problem: ProblemDetails | TransportFailure };

type State = {
  form: Form;
  phase: Phase;
  copy: { what: 'url' | 'curl'; outcome: 'copied' | 'failed' } | undefined;
};

type Event =
  | { type: 'field'; name: keyof Form; value: string }
  | { type: 'submit'; requestUrl: URL; controller: AbortController }
  | { type: 'resolved'; requestUrl: URL; source: SourceInfo | SourceError; processed: ProcessResult; objectUrl: string }
  | { type: 'failed'; requestUrl: URL; problem: ProblemDetails | TransportFailure }
  | { type: 'copied'; what: 'url' | 'curl' }
  | { type: 'copy-failed'; what: 'url' | 'curl' }
  | { type: 'copy-cleared' };

function reduce(state: State, event: Event): State;   // pure
```

Form fields are strings because they mirror inputs; the SDK call converts. `reduce` has no
side effects: `main.ts` creates the `AbortController` and the request URL when it
dispatches `submit`, and after every reduction it compares the old and new phase, aborting
a replaced `loading` controller and revoking a replaced `success` object URL. `api.ts`
creates the object URL from the processed bytes and the `resolved` event carries it.

`reduce` applies `resolved` and `failed` only while the phase is `loading` with the same
`requestUrl` object. The comparison is by identity, not `href`: resubmitting the same
parameters builds an equal URL, and the abort failure of the request it replaced must not
settle it. A `field` event for `crop` or `format` whose value is not in the SDK's lists sets
the blank. `submit` clears `copy`, since the status belonged to the previous URL. The
phase comparison is `effectsFor(before, after)` in `state.ts` beside `reduce`. Leaving a
`loading` phase yields its controller to abort: on a resubmission that cancels the replaced
request, on a failure it cancels the other call still in flight, and after a success the
abort does nothing. Leaving a `success` phase yields its object URL to revoke.

## Modules

- `state.ts`: the types above, `reduce`, and `effectsFor`.
- `api.ts`: `paramsFromForm(form): ProcessParams` is the one place the form is converted;
  `main.ts` uses it to build the request URL on `submit`, and `run(client, form,
  requestUrl, signal): Promise<Event>` uses it, then calls `client.info` and
  `client.process` in parallel, and returns a `resolved` or `failed` event carrying the
  `requestUrl` it was given. The source info failing while the processed image succeeds
  is `resolved` with `source` set to a `SourceError` carrying the problem, so the page
  still shows the result. Only a problem the service sent becomes a `SourceError`; a
  transport failure of `/info` makes the event `failed`, as one of `/process` does.
- `render.ts`: `mount(root, dispatch): (state: State) => void` builds the page into `root`
  once, attaching listeners that call `dispatch`, and returns the update function, which
  closes over the page's elements and the last phase it rendered. Elements are built with a
  small `el(tag, attrs, children)` helper in the same file; all text goes through
  `textContent` or attribute setters. Each update sets the copy statuses, and only when
  the phase object changed rewrites the request URL and curl text, the field errors, and the
  panels. Typing and copying keep the phase object, so the input being typed in and the
  button just pressed keep focus and the images are not reloaded. The inputs start blank, as
  `initialState.form` is. `dispatch` takes an `Event` or `{ type: 'submit-requested' }`,
  which is what the form sends, since the `submit` event carries the URL and controller
  that `main.ts` creates (decision 48). A copy button writes the displayed text to the
  clipboard and dispatches `copied`, or `copy-failed` when `navigator.clipboard` is absent
  (it exists only in a secure context, so not on the dev server reached over a LAN address)
  or the write is refused; either way it dispatches `copy-cleared` two seconds later through
  one timer shared by both buttons, so a second copy keeps its status for the full two
  seconds. The original image's `error` listener, which replaces the image with a
  paragraph, is the one listener that changes the page without dispatching: the browser's
  failure to display the original is not application state, and decision 69 makes it the
  exception to the rule that a second render path means the state shape is wrong.
- `main.ts`: creates the client from `location.origin`, mounts the page on `document.body`,
  holds the state and the update function `mount` returned, never element references, and
  runs the loop: `dispatch(event)` turns `submit-requested` into `submit`, reduces, performs
  the abort and revoke described above, calls the update function, and if the new phase is
  a `loading` phase it did not have before, calls `api.run` with the client, the form, the
  request URL, and the controller's signal, and dispatches its result.

## Page

Three regions under a heading:

1. **Form.** Source URL (required), width, height, crop (select with a blank "default: fit"
   option), format (select with blank "same as source"), quality. Submit on button or Enter.
   Field errors from a problem's `errors` appear beside the matching input.
2. **Request.** The exact request URL from `processUrl` and the curl line from `curlFor`,
   each with a copy button that shows "Copied" for two seconds, or "Copy failed; select
   the text instead" when the clipboard is unavailable or refuses the write. Shown from the
   first submit on, including in the error state.
3. **Images.** Two panels, original and processed. Each shows the image, then dimensions,
   format, and size in a definition list. The original is an `img` pointing at the source
   URL, with metadata from `/info`; if `/info` failed, its problem is shown in the panel.
   If the browser cannot display the original (a format it cannot decode, TIFF for one; a
   hotlink rule; a mixed-content block on the https deployment; a host only the service
   reaches), the image's `error` event replaces it with a paragraph saying the browser
   could not display the original image and that the details below come from the service;
   the metadata or problem stays.
   The processed image is the object URL of the SDK's bytes, with metadata from the result
   and the size from `bytes.byteLength`. The processed panel shows a loading indicator
   during `loading` and the problem (`title`, `detail`, `code`, `requestId`) during `error`.

Empty state: the panels show short guidance text and no images. Nothing is hidden by
default; disabled elements stay visible. Before the first submit the request region shows
guidance text and its copy buttons are disabled. In the error state the original panel says
there is no source image. The original image's `src` is the `url` parameter of the request
URL, so editing the form after a request does not change what the panels show. An
identical resubmission may be answered from the browser's HTTP cache, since `/process` and
`/info` responses carry a public `max-age` (architecture section 7); the UI adds no
cache-busting parameter, so the displayed URL stays the one `processUrl` builds (decision 50).

## Accessibility and layout

Every input has a `label`. The error and copy status regions are `aria-live="polite"`:
the processed panel's content, which holds the loading indicator and the problem, and one
status beside each copy button. Each input names its field-error element in
`aria-describedby` and sets `aria-invalid` while that element has text. Each copy button
names its status in `aria-describedby`, so the button is described as "Copied" or the
failure message while the status shows (decisions 49 and 69). The layout is a single column
at 360 px and two columns for the panels above 800 px, in `styles.css`, no framework. Images
use `max-width: 100%`.

## Build

`build.ts` runs esbuild with `bundle: true`, `format: 'esm'`, `target: 'es2022'`,
`minify` in production, `sourcemap` in dev, entry `src/main.ts`, outfile
`dist/assets/app.js`; copies `index.html` and `favicon.ico` to `dist/` and `styles.css` to
`dist/assets/`. `--watch` rebuilds on change. The API serves `dist/` locally with the same
paths CloudFront routes to S3.

`build.ts` empties `dist/` before building, so the layout holds exactly those four files
(plus `app.js.map` in dev). Without `--watch` it is the production build; with `--watch` it
is the dev build, esbuild's watch rebuilds the bundle, and a watcher on `apps/web` recopies
a static file when it changes, since esbuild watches only the bundle's inputs; a file missing
at that moment (a save by rename, a checkout) is skipped, and its re-creation copies it.
esbuild resolves `@image-service/sdk` to its built `dist/`, so the SDK is built first: the
root `build` runs `tsc -b` before the web build. The root `dev` runs `dev.ts`, which starts
the SDK's `tsc --watch`, this watch, and the API's dev script, each in its own process
group, and signals every group when one child exits or on `SIGINT` or `SIGTERM`.

## Tests

Unit: `reduce` over each event from each phase; and `main.ts`'s phase comparison, which is
a pure function `effectsFor(before, after)`, kept in `state.ts` so it imports without the
page, returning the controller to abort and the URL to revoke. `api.ts`: `paramsFromForm`,
and `run` against an `ImageClient` with an injected `fetch` for each outcome above. The DOM
is covered by the end-to-end suite (`e2e/`), which exercises every state in the list above
through the real API and the fake upstream. The original the browser cannot display is
driven through the stack with a TIFF source, which the service reads and Chromium cannot
decode, and, for the hotlink case, by answering the page's own request for a JPEG source
with a 403 through `page.route`, which the service's fetch never passes through. The copy
failure has no counterpart in the stack, so its specs change only the browser: an init
script removes `navigator.clipboard` or makes `writeText` reject.
