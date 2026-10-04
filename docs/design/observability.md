# Design: observability

Structured logs and request-ID propagation. Metrics are out of scope (decision 17).
Directory: `apps/api/src/observability/`, one file, `logger.ts`.

## Logger

```ts
type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, string | number | boolean | undefined>;

type Logger = {
  child(fields: Fields): Logger;
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields, err?: unknown): void;
};

function createLogger(level: Level, sink?: (line: string) => void, now?: () => number): Logger;
```

`err` is a separate parameter because an `Error` cannot live inside `Fields`, whose index
signature admits only primitives. `Logger` is an object type built by a closure, not an
interface with a class behind it. One JSON object per line:
`{ time, level, msg, ...childFields, ...fields, err? }`. `err` is expanded to
`{ name, message, stack, cause }` with the `cause` chain followed. The default sink is
`process.stdout.write` and the default clock is `Date.now`; tests pass an array-collecting
sink and a fixed clock. No dependency: the whole module is under eighty lines and every
field is one the service chose.

Locally and on Lambda the lines go to stdout. On Lambda, CloudWatch Logs captures them and
Logs Insights can query any field.

## Request context

The `request-id` middleware creates `logger.child({ requestId })` and stores it on the Hono
context; operations receive it as a separate argument, so `deps` are built once. One request log line is written per response
(fields in `design/http-api.md`). Errors mapped to 5xx are logged at `error` with `err`;
4xx at `info` with `code` only.

## Field rules

- `hostname` for source hosts, never `url`.
- Never `bytes` of a body, never request headers other than those the service reads.
- Durations in milliseconds as `durationMs`.
- `level` filtering is by `LOG_LEVEL`; `debug` lines are not formatted when filtered.

## Tests

The logger's output shape, child field merging, level filtering, and `err` expansion with a
`cause` chain. A request-log test in the HTTP suite asserts the fields of one line.
