# Design: image pipeline

Implements `docs/architecture.md` section 4 steps 8 to 10 and the parameter semantics in
section 7. Directory: `apps/api/src/image/`. `pipeline.ts` is the only module in
`apps/api/src` that imports sharp.

## spec.ts

```ts
type CropMode = 'fit' | 'fill' | 'scale' | 'pad';
type OutputFormat = 'jpeg' | 'png' | 'webp' | 'avif';

type Encoding =
  | { format: 'png' }
  | { format: Exclude<OutputFormat, 'png'>; quality: number };

type TransformSpec = {
  url: URL;
  width: number | undefined;
  height: number | undefined;
  crop: CropMode;
} & (Encoding | { format: 'source'; quality: number });

function toSpec(params: ProcessParams, defaults: { quality: number }): TransformSpec;
function cacheKey(spec: TransformSpec): string;   // format in design/caching.md
function resolveEncoding(spec: TransformSpec, source: SourceType): Encoding;
```

`ProcessParams` is the SDK's validated parameter type; `toSpec` also accepts it with
`| undefined` on each optional field, which is how the route's Zod schema types an omitted
field (decision 45). `toSpec` applies defaults:
`crop` to `fit`, `quality` to `DEFAULT_QUALITY`, `format` to `'source'`. For `format: 'png'`
it drops `quality`, given or defaulted, because the PNG encoder never receives one; the spec,
the cache key, and the ETag therefore do not vary with it (decision 58). `'source'` keeps
its quality, since it may resolve to a lossy format. Range validation has already happened
in the route. `cacheKey` is pure and total. `resolveEncoding` resolves `'source'` against the
sniffed type (the mapping under "Output mapping") and returns the format with its quality,
or png with none; the pipeline encodes with it and the operation uses it to drop quality
from the ETag of a `'source'` request that resolves to png (decision 60).

## dimensions.ts

```ts
function outputDimensions(
  source: { width: number; height: number },   // oriented, as inspect reports them
  spec: Pick<TransformSpec, 'width' | 'height' | 'crop'>,
): { width: number; height: number };
```

Pure. The dimensions `transform` will produce, computed before any pixel is decoded so the
AVIF pixel cap can refuse a request without paying for it. It reproduces sharp's resize
arithmetic (`ResolveShrink` in sharp's `common.cc`, verified against sharp 0.35.5):

- No dimension: the source size.
- `fill` and `pad` with both dimensions, and `scale` with either or both: the requested
  dimensions, with an omitted one staying the source's (sharp's `fill` ignores the aspect
  ratio, so it does not derive the other dimension).
- Otherwise one uniform shrink factor, source over target: for `fit` the larger of the two
  factors and never below 1 (`withoutEnlargement`); for `fill` and `pad` with one dimension,
  that dimension's factor. Each axis is the source axis divided by the factor, capped so no
  axis drops below one pixel, rounded half up as libvips does.

A JPEG source decoded with shrink-on-load can come out a pixel off this arithmetic; the cap
tolerates that.

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
`maxOutputBytes`, and `maxAvifOutputPixels`.

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

1. Resolve the output format. When it is avif, compute the output dimensions with
   `outputDimensions(info, spec)` and throw `output_too_large` if their product exceeds
   `maxAvifOutputPixels`, before the input is opened. The detail names
   `MAX_AVIF_OUTPUT_PIXELS`, the computed dimensions and pixel count, and the limit. sharp's
   timeout is checked only during libvips evaluation and does not interrupt the AVIF encoder,
   so pixel count is what bounds its time (decision 64).
2. `sharp(bytes, { limitInputPixels: maxInputPixels })` with `.timeout({ seconds })`.
   `transform` passes the limit itself so it is safe for any caller that skipped `inspect`.
3. `.autoOrient()`: applies the EXIF orientation so later dimensions are the visual ones.
4. Resize per the table below, only if `width` or `height` is set.
5. Encode per the output table. Metadata is stripped because nothing calls
   `withMetadata()`.
6. Check the byte length against `maxOutputBytes`; throw `output_too_large`.

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

The source-to-output mapping and `resolveEncoding` live in `spec.ts`; the encoder options
live here.

| Output | Encoder options |
|---|---|
| jpeg | `{ quality }`: plain libjpeg; `mozjpeg` is not set, because sharp's timeout does not interrupt it |
| png | `{}` (quality is not passed; it would trigger palette quantization) |
| webp | `{ quality }` |
| avif | `{ quality, effort: 0 }`: the lowest effort, because sharp's timeout does not interrupt the encoder |

The format and quality come from `resolveEncoding(spec, info.format)`, so the PNG encoder
is never handed a quality. `format: 'source'` resolves from `info.format`, the sniffed type:
jpeg, png, webp, avif map to themselves; tiff maps to png; gif maps to png. GIF output is not
offered because it would be a lossy re-quantization of the first frame with no benefit over
png.

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

`dimensions.test.ts`: a table of source, spec, and expected dimensions covering every crop
mode with both dimensions, with each one alone, and with none; `fit` never enlarging, with
a box and with one dimension; rounding of a derived dimension, including an exact half; and
the one-pixel floor. The same table runs through `transform` on generated sources, so a
sharp upgrade that changes the arithmetic fails the test.

`spec.test.ts`: defaults applied; `resolveEncoding` for an omitted format on png, tiff,
gif, and jpeg sources and for an explicit format; quality dropped for `format: 'png'` and kept for every
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
  outputs byte-identical) for `format: 'source'` on a png source, the one path where a spec
  quality can meet the PNG encoder, since a `format: 'png'` spec carries none.
- A `noise` source whose png output exceeds a small `maxOutputBytes` throws
  `output_too_large`; the same with jpeg passes.
- An avif output above a small `maxAvifOutputPixels` throws `output_too_large` with the
  detail naming the variable and the computed size; the same source resized under the cap,
  or encoded as webp, passes; a source kept as avif is capped too.
- A source above a small `maxInputPixels` throws `source_too_large` from the operation's
  check after `inspect`; `transform` called directly on the same source, without that
  check, also throws `source_too_large` (mapped from sharp's pixel-limit error).
- `transform_timeout` mapping is tested by constructing the error sharp produces; a real
  timeout is not provoked in tests because the whole-second granularity makes it
  machine-dependent (decision 33).
