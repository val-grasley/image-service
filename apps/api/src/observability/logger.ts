import type { LogLevel } from '../config.ts';

export type Fields = Record<string, string | number | boolean | undefined>;

export type Logger = {
  child(fields: Fields): Logger;
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields, err?: unknown): void;
};

const PRIORITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

type SerializedError = {
  name: string;
  message: string;
  stack: string | undefined;
  cause: SerializedError | string | undefined;
};

function serializeError(err: unknown): SerializedError | string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
    cause: err.cause === undefined ? undefined : serializeError(err.cause),
  };
}

export function createLogger(
  level: LogLevel,
  sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  now: () => number = Date.now,
): Logger {
  const threshold = PRIORITY[level];

  const make = (context: Fields): Logger => {
    const write = (lvl: LogLevel, msg: string, fields: Fields | undefined, err?: unknown) => {
      if (PRIORITY[lvl] < threshold) {
        return;
      }
      const line: Record<string, unknown> = {
        time: new Date(now()).toISOString(),
        level: lvl,
        msg,
        ...context,
        ...fields,
      };
      if (err !== undefined) {
        line.err = serializeError(err);
      }
      sink(JSON.stringify(line));
    };
    return {
      child: (fields) => make({ ...context, ...fields }),
      debug: (msg, fields) => {
        write('debug', msg, fields);
      },
      info: (msg, fields) => {
        write('info', msg, fields);
      },
      warn: (msg, fields) => {
        write('warn', msg, fields);
      },
      error: (msg, fields, err) => {
        write('error', msg, fields, err);
      },
    };
  };

  return make({});
}
