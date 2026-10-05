# Design: image pipeline

Implements `docs/architecture.md` section 4 steps 8 to 10 and the parameter semantics in
section 7. Directory: `apps/api/src/image/`. `pipeline.ts` is the only module in
`apps/api/src` that imports sharp.

## spec.ts

```ts
type CropMode = 'fit' | 'fill' | 'scale' | 'pad';
type OutputFormat = 'jpeg' | 'png' | 'webp' | 'avif';

type TransformSpec = {
  url: URL;
  width: number | undefined;
  height: number | undefined;
  crop: CropMode;
} & ({ format: 'png' } | { format: Exclude<OutputFormat, 'png'> | 'source'; quality: number });

function toSpec(params: ProcessParams, defaults: { quality: number }): TransformSpec;
function cacheKey(spec: TransformSpec): string;   // format in design/caching.md
```

`ProcessParams` is the SDK's validated parameter type; `toSpec` also accepts it with
`| undefined` on each optional field, which is how the route's Zod schema types an omitted
field (decision 45). `toSpec` applies defaults:
`crop` to `fit`, `quality` to `DEFAULT_QUALITY`, `format` to `'source'`. For `format: 'png'`
it drops `quality`, given or defaulted, because the PNG encoder never receives one; the spec,
the cache key, and the ETag therefore do not vary with it (decision 58). `'source'` keeps
its quality, since it may resolve to a lossy format. Range validation has already happened
in the route. `cacheKey` is pure and total.

## pipeline.ts

```ts
type InspectResult = Pick<SourceInfo, 'format' | 'width' | 'height' | 'pages'>; // SDK's /info shape

type TransformResult = {
  bytes: Uint8Array;
  format: OutputFormat;
  contentType: string;
  width: number;
  height: number;
};

const PIPELINE_REVISION: string;   // bumped when output for the same input changes
function pipelineVersion(): string; // `${sharp.versions.sharp}/${PIPELINE_REVISION}`

function inspect(bytes: Uint8Array, type: SourceType): Promise<InspectResult>;
function transform(bytes: Uint8Array, info: InspectResult, spec: TransformSpec, limits: PipelineLimits): Promise<TransformResult>;
function fromSharpError(error: unknown): ServiceError; // exported so the mapping is testable in isolation
```

`PipelineLimits` is the slice of `Config` with `maxInputPixels`, `transformTimeoutSeconds`,
and `maxOutputBytes`.

**inspect** reads the header through sharp's `metadata()` without decoding pixels. It opens
the input with `limitInputPixels: false`, because the limit is enforced when the input is
opened and would otherwise turn an oversized header into an opaque error before the
dimensions are known. `format` is the sniffed `type` passed in, not sharp's decoder id
(sharp reports AVIF as `heif`). `width` and `height` are the dimensions after EXIF
orientation (sharp's `metadata().autoOrient`), so `/info` reports what `/process` without a
resize returns; the pixel count is the same either way. The operation compares `width * height` with
`MAX_INPUT_PIXELS` and throws `source_too_large` before calling `transform`. `pages`
defaults to 1 when sharp omits it. A header sharp cannot parse throws
`unsupported_source_type`.

**transform**, in this fixed order:

1. `sharp(bytes, { limitInputPixels: maxInputPixels })` with `.timeout({ seconds })`.
   `transform` passes the limit itself so it is safe for any caller that skipped `inspect`.
2. `.autoOrient()`: applies the EXIF orientation so later dimensions are the visual ones.
3. Resize per the table below, only if `width` or `height` is set.
4. Encode per the output table. Metadata is stripped because nothing calls
   `withMetadata()`.
5. Check the byte length against `maxOutputBytes`; throw `output_too_large`.

### Resize mapping

| `crop` | sharp `fit` | `withoutEnlargement` | Result |
|---|---|---|---|
| `fit` | `inside` | true | At most the requested box, aspect preserved, never larger than the source |
| `fill` | `cover` | false | Exactly the requested size, center crop, may enlarge |
| `scale` | `fill` | false | Exactly the requested size, aspect ignored, may enlarge |
| `pad` | `contain` | false | Exactly the requested size, aspect preserved, padded |

With one dimension: sharp scales to that dimension preserving aspect; `fit` still passes
`withoutEnlargement: true`, the others do not. sharp's `fill` means stretch, which is our
`scale`; the mapping is one function with one test per row on a non-square source.

`pad` background: transparent when the output format supports alpha (png, webp, avif),
else white. `fill` crops from the center; `gravity` and attention-based cropping are not
offered.

### Output mapping

| Output | Encoder options |
|---|---|
| jpeg | `{ quality, mozjpeg: true }` |
| png | `{}` (quality is not passed; it would trigger palette quantization) |
| webp | `{ quality }` |
| avif | `{ quality, effort: 2 }` |

The quality comes from the spec; a spec with `format: 'png'` has none, and one with
`format: 'source'` that resolves to png has one the encoder does not receive.
`format: 'source'` resolves from `info.format`, the sniffed type: jpeg, png, webp, avif map
to themselves; tiff maps to png; gif maps to png. GIF output is not offered because it would be a lossy
re-quantization of the first frame with no benefit over png.

Animated inputs contribute their first frame, which is sharp's default when `animated` is
not set.

`contentType` is `image/<format>`.

### Errors

sharp's timeout surfaces as an `Error` whose message starts with the line
`timeout: <n>% complete`, usually followed by libvips's own lines (observed with sharp
0.35.5: `timeout: 43% complete\nVipsImage: killed for image "temp-97"`; decision 41);
`fromSharpError` maps a message matching `/^timeout: \d+% complete(?:\n|$)/` to
`transform_timeout`. sharp's input-too-large error (`Input image exceeds pixel limit`)
maps to `source_too_large`. Anything else propagates as `internal_error` with the original
as `cause`.

## Tests

`spec.test.ts`: defaults applied; quality dropped for `format: 'png'` and kept for every
other format, including `'source'`; `cacheKey` is identical for two specs with equal fields,
and for two png specs differing only in quality, distinct for each other single field
change, and contains the href.

`pipeline.test.ts`, using `generateImage` from the fake upstream package:

- One test per resize row on a 400 by 200 `quadrants` source with width 100 and height
  100, asserting dimensions and, for `fill`, the center pixel colors; `fit` on a 100 by 50
  source with width 400 returns 100 by 50; `pad` on png has transparent corners and on
  jpeg white ones.
- One dimension: width 200 on 400 by 200 gives 200 by 100.
- Orientation 6 source: output dimensions are the visual ones and the quadrant colors are
  rotated; output has no EXIF.
- Each output format round-trips through `inspect`; `format: 'source'` on tiff and gif
  yields png.
- `quality` 10 versus 90 on jpeg produces fewer bytes; `quality` on png is ignored (two
  outputs byte-identical), both for `format: 'png'` and for `'source'` on a png source.
- A `noise` source whose png output exceeds a small `maxOutputBytes` throws
  `output_too_large`; the same with jpeg passes.
- A source above a small `maxInputPixels` throws `source_too_large` from the operation's
  check after `inspect`; `transform` called directly on the same source, without that
  check, also throws `source_too_large` (mapped from sharp's pixel-limit error).
- `transform_timeout` mapping is tested by constructing the error sharp produces; a real
  timeout is not provoked in tests because the whole-second granularity makes it
  machine-dependent (decision 33).
