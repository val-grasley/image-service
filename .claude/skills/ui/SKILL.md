---
name: ui
description: "Use when working in apps/web/: the single-page UI, its state, render, and api modules, its esbuild script, or its styles."
paths:
  - apps/web/**
---

# UI

The state model, the events, the module split, the page regions, the build output, and the
test plan are `docs/design/ui.md`. The UI consumes the API only through
`@image-service/sdk`.

## Rules this skill adds

- If a change wants a second render path, an element reference held outside `render.ts`,
  or a side effect inside `reduce`, the state shape is wrong; fix the state. Only
  `render.ts` creates or queries elements; `main.ts` holds nothing but the root it passes
  in. Listeners that change application state go through `dispatch`; a listener that only
  reports a browser-side failure on its own element may change the page directly
  (decision 69).
- The processed image is requested through the SDK client, never with an `img` element
  pointing at the API: that path fails silently and exposes no headers.
- Every string from the API or the user enters the DOM through `textContent` or an
  attribute setter. No `innerHTML` with dynamic content, including in templates.
- The displayed request URL is the SDK's `processUrl` output; the UI never concatenates
  it.

## Build

`build.ts` writes the `dist/` layout the design document's "Build" section gives, which is
also what CloudFront routes to S3. A change to that layout changes
`docs/design/infrastructure.md` behaviors in the same commit. Accessibility and layout
minimums are the document's "Accessibility and layout" section.
