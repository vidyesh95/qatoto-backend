import { config } from "#src/config/index.js";

/**
 * Structured logging (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 6).
 *
 * WHY ZERO DEPENDENCIES. This repo calls Gemini, Brevo, YouTube and the geocoder with plain
 * `fetch` and no SDK, on the stated grounds that a wrapper around one HTTP call is a
 * dependency bought for nothing. A JSON-line logger is the same size of problem: pino is
 * excellent and would earn its place the day this needs transports, sampling or child
 * loggers with bound context. It does not need them yet, and the thing that was actually
 * missing is not a library — it is a REQUEST ID IN THE LINE.
 *
 * WHAT WAS BROKEN. `request-id.ts` minted an id and returned it in `X-Request-Id`, and
 * nothing ever wrote it anywhere. A user quoting their request id handed support a string
 * that appeared in no log on any machine. morgan's `"dev"` format cannot carry one, in any
 * environment, because it has no access to a value set on `req`.
 *
 * ONE LINE PER EVENT, JSON in production and a readable form in development — the same
 * split `error-handler.ts` already makes for stack traces, and for the same reason: a
 * developer reads a terminal, a log aggregator parses a stream.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  readonly [key: string]: unknown;
}

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * `debug` in development, `info` elsewhere. Deliberately not configurable by env yet: a
 * level nobody has needed to change is a knob to add when somebody does, and the one thing
 * worse than no logs is a production deployment silenced by a typo in a variable.
 */
const MINIMUM_LEVEL: LogLevel = config.NODE_ENV === "development" ? "debug" : "info";

function write(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[MINIMUM_LEVEL]) return;

  const line = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...fields,
  };

  const serialized =
    config.NODE_ENV === "development"
      ? `${level.toUpperCase()} ${message} ${Object.keys(fields).length > 0 ? JSON.stringify(fields) : ""}`.trimEnd()
      : safeStringify(line);

  if (level === "error") {
    console.error(serialized);
    return;
  }
  if (level === "warn") {
    console.warn(serialized);
    return;
  }
  console.log(serialized);
}

/**
 * A log line must never be the thing that throws.
 *
 * A circular object, or a BigInt anywhere in the fields, makes `JSON.stringify` raise — and
 * a logger that throws inside an error handler turns a 500 into a crash.
 */
function safeStringify(line: unknown): string {
  try {
    return JSON.stringify(line, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
  } catch {
    return JSON.stringify({
      level: "error",
      message: "log line could not be serialized",
      timestamp: new Date().toISOString(),
    });
  }
}

export const logger = {
  debug: (message: string, fields?: LogFields): void => {
    write("debug", message, fields);
  },
  info: (message: string, fields?: LogFields): void => {
    write("info", message, fields);
  },
  warn: (message: string, fields?: LogFields): void => {
    write("warn", message, fields);
  },
  error: (message: string, fields?: LogFields): void => {
    write("error", message, fields);
  },
};

/**
 * Turns an unknown thrown value into loggable fields.
 *
 * `catch` binds `unknown` under this tsconfig, and half the interesting cases are not
 * `Error` — a Postgres driver error carries `code`, a rejected fetch carries `cause`.
 */
export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      ...(config.NODE_ENV === "development" ? { stack: error.stack } : {}),
      // A Postgres driver error carries `code`; a plain Error does not. Read through an
      // index signature rather than an assertion — this is a check, not a claim.
      ...("code" in error && typeof error.code === "string" ? { errorCode: error.code } : {}),
    };
  }
  return { errorMessage: String(error) };
}
