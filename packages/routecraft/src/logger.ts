import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  openSync,
  existsSync,
  rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, isAbsolute, basename } from "node:path";
import { homedir } from "node:os";
import { pino, stdSerializers } from "pino";
import type { Route } from "./route.ts";
import {
  type Exchange,
  getExchangeContext,
  HeadersKeys,
  principalOf,
} from "./exchange.ts";
import { isCraftContext, isRoute, isExchange } from "./brand.ts";
import type { CraftContext } from "./context.ts";
import { loadOptionalPeerSync } from "./adapters/shared/optional-peer.ts";

const require = createRequire(import.meta.url);

/** The severity of one log line. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/**
 * The levels a `.log()` step may write at. A failure is logged once, at the
 * boundary that handles it, so a step in the flow never writes `error` or
 * `fatal`.
 */
export type StepLogLevel = "trace" | "debug" | "info" | "warn";

/** The lowest level a logger writes, or `"silent"` for none. */
export type LogThreshold = LogLevel | "silent";

/** The fields a log line or a child logger carries. */
export type LogBindings = Readonly<Record<string, unknown>>;

/** One level of a {@link Logger}: fields and a message, or a message alone. */
export interface LogFn {
  (bindings: LogBindings, message: string): void;
  (message: string): void;
}

/**
 * The logger Routecraft writes to, and the one a context, a plugin and an
 * exchange hand out. A pino logger satisfies it without an adapter; so does
 * anything else with these members.
 *
 * A call never throws: a logger that can fail has to contain the failure
 * itself, because the framework logs from places that have no way to
 * recover from one.
 */
export interface Logger {
  /** A logger whose every line also carries `bindings`. */
  child(bindings: LogBindings): Logger;
  /** Whether a line at `level` would be written. */
  isLevelEnabled(level: LogLevel): boolean;
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  /** Write out anything buffered. The CLI awaits it before the process exits. */
  flush?(): Promise<void> | void;
}

/** What {@link createLogger} builds its logger from. */
export interface DefaultLoggerOptions {
  /** The lowest level written. Default `"warn"`. */
  level?: LogThreshold;
  /** Append to this file instead of a standard stream. */
  file?: string;
  /** The standard stream written to when no file is named. Default `"stdout"`. */
  stream?: "stdout" | "stderr";
  /**
   * Paths whose values are replaced before a line is written, in pino's
   * redaction syntax. Added to {@link DEFAULT_REDACT}, never instead of it.
   */
  redact?: readonly string[];
  /**
   * Human-readable lines through the optional peer `pino-pretty` instead of
   * NDJSON. Ignored when `file` is set. Default `false`.
   */
  pretty?: boolean;
}

/**
 * The paths every logger built here redacts: the headers that carry a
 * credential, on a line that logs an exchange's or a request's `headers`.
 */
export const DEFAULT_REDACT: readonly string[] = [
  "headers.authorization",
  "headers.cookie",
  'headers["set-cookie"]',
  'headers["proxy-authorization"]',
];

/**
 * Serialize a logged error, collapsing a cause that only repeats the message.
 *
 * pino appends a cause's message to the error's own, which is what you want
 * when they differ: "Adapter operation failed: the socket closed" says more
 * than either half. The framework routinely makes them identical, because
 * `processError` wraps an arbitrary throw as `RC5001` and takes the thrown
 * message as its own while keeping the original as the cause for its stack.
 * The reader then gets the same sentence twice, joined by a colon, on every
 * adapter failure and on the longest messages worst:
 *
 *     "The socket connection was closed unexpectedly...: The socket
 *      connection was closed unexpectedly..."
 *
 * Only the exact duplicate is collapsed. A cause that says something the
 * error does not is still appended, and nothing here changes any error's own
 * `message`, which is what the rest of the framework reads.
 *
 * @internal Exported for tests.
 */
export function serializeError(error: unknown): unknown {
  const serialized = stdSerializers.err(
    error as Parameters<typeof stdSerializers.err>[0],
  );
  const cause: unknown = (error as { cause?: unknown }).cause;
  if (!(cause instanceof Error)) return serialized;
  if (serialized.message === `${cause.message}: ${cause.message}`) {
    serialized.message = cause.message;
  }
  return serialized;
}

const THRESHOLDS: readonly LogThreshold[] = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
];

function isThreshold(value: unknown): value is LogThreshold {
  return THRESHOLDS.includes(value as LogThreshold);
}

/**
 * The three settings `craft.log.{cjs,js}` may carry, from the first file
 * found in the working directory, then in `~/.routecraft`. Anything else in
 * the file is ignored, and so is a file that cannot be loaded: the logger is
 * built from it, so there is nowhere yet to report it.
 */
function loadConfigFile(): Pick<
  DefaultLoggerOptions,
  "level" | "file" | "redact"
> {
  const dirs = [process.cwd(), resolve(homedir(), ".routecraft")];
  const names = ["craft.log.cjs", "craft.log.js"];
  for (const dir of dirs) {
    for (const name of names) {
      const path = resolve(dir, name);
      if (!existsSync(path)) continue;
      try {
        const loaded: unknown = require(path);
        const config: unknown =
          (loaded as { default?: unknown } | null)?.default ?? loaded;
        if (config === null || typeof config !== "object") continue;
        const { level, file, redact } = config as Record<string, unknown>;
        return {
          ...(isThreshold(level) ? { level } : {}),
          ...(typeof file === "string" && file !== "" ? { file } : {}),
          ...(Array.isArray(redact)
            ? {
                redact: redact.filter(
                  (path): path is string => typeof path === "string",
                ),
              }
            : {}),
        };
      } catch {
        continue;
      }
    }
  }
  return {};
}

/**
 * A log file the logger was asked for and could not open. Read by the CLI,
 * which owns the setting and refuses to run with its logs diverted.
 *
 * @internal
 */
export interface LogFileDiversion {
  /** The file as it was named. */
  path: string;
  /** Where the name came from. */
  source: "LOG_FILE" | "CRAFT_LOG_FILE" | "craft.log" | "createLogger";
  /** Why it could not be opened for appending. */
  reason: string;
}

let diversion: LogFileDiversion | undefined;

/**
 * The log file the default logger could not open, if it was asked for one.
 *
 * A logger never fails over its destination: an embedding application
 * cannot be stopped by its logger, so a file that cannot be opened diverts
 * the logs to a file of the same name in the temporary directory, then to
 * standard error. A host that owns the setting reads this to refuse instead.
 *
 * @internal
 */
export function logFileDiversion(): LogFileDiversion | undefined {
  return diversion;
}

type Destination = ReturnType<typeof pino.destination>;

/**
 * Written synchronously, which is pino's standard mode: a line is on its
 * way out when the call returns, so none is lost to a process that exits
 * right after, and `flush` has nothing to wait for.
 */
function destinationFor(fd: number): Destination {
  return pino.destination({ dest: fd, sync: true });
}

/**
 * Open where the lines go: the named file, or the standard stream. An
 * adapter that owns stdout (MCP stdio) needs a file, stderr or `silent`.
 */
function openDestination(
  file: string | undefined,
  fd: 1 | 2,
  source: LogFileDiversion["source"],
): Destination {
  if (file === undefined) return destinationFor(fd);
  const resolved = isAbsolute(file) ? file : resolve(process.cwd(), file);
  try {
    mkdirSync(dirname(resolved), { recursive: true });
    return destinationFor(openSync(resolved, "a"));
  } catch (error: unknown) {
    diversion = {
      path: file,
      source,
      reason: error instanceof Error ? error.message : String(error),
    };
    let privateDir: string | undefined;
    try {
      // A private directory of this process's own: a fixed name under the
      // shared temp dir could be a symlink somebody else planted.
      privateDir = mkdtempSync(join(tmpdir(), "craft-log-"));
      return destinationFor(openSync(join(privateDir, basename(file)), "a"));
    } catch {
      if (privateDir !== undefined) {
        try {
          rmdirSync(privateDir);
        } catch {
          // Best effort: the diversion to stderr below still stands.
        }
      }
      // A file was asked for to keep stdout clean; stderr honours that.
      return destinationFor(2);
    }
  }
}

/**
 * The `pino-pretty` stream, or `undefined` when the peer is absent and was
 * only wanted by default. Asked for by name, an absent peer is `RC5017`.
 */
function prettyDestination(fd: 1 | 2, required: boolean): unknown {
  try {
    const loaded = loadOptionalPeerSync(
      () => require("pino-pretty") as unknown,
      { consumer: "pretty log output", packageName: "pino-pretty" },
    );
    const build = ((loaded as { default?: unknown }).default ?? loaded) as (
      options: Record<string, unknown>,
    ) => unknown;
    return build({ colorize: true, destination: fd, sync: true });
  } catch (error: unknown) {
    if (required || (error as { rc?: unknown } | null)?.rc !== "RC5017") {
      throw error;
    }
    return undefined;
  }
}

function build(
  options: DefaultLoggerOptions,
  source: LogFileDiversion["source"],
  prettyRequired: boolean,
): Logger {
  const settings = {
    level: options.level ?? "warn",
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
    serializers: { err: serializeError },
    redact: [...new Set([...DEFAULT_REDACT, ...(options.redact ?? [])])],
  };
  const fd = options.stream === "stderr" ? 2 : 1;
  if (options.pretty === true && options.file === undefined) {
    const pretty = prettyDestination(fd, prettyRequired);
    if (pretty !== undefined) {
      return pino(settings, pretty as Destination);
    }
  }
  return pino(settings, openDestination(options.file, fd, source));
}

/**
 * Build a logger: NDJSON to a standard stream or a file, with the headers
 * that carry a credential redacted. Nothing is read from the environment or
 * from `craft.log.*`; that is {@link defaultLogger}.
 *
 * @param options - Level, destination, redaction and format
 * @returns A logger to hand to `defineProject({ logger })` or a context
 * @throws RC5017 when `pretty` is set and `pino-pretty` is not installed
 *
 * @example
 * ```typescript
 * export default defineProject({
 *   logger: createLogger({ level: "info", stream: "stderr" }),
 * });
 * ```
 */
export function createLogger(options: DefaultLoggerOptions = {}): Logger {
  return build(options, "createLogger", true);
}

function firstSet(...names: string[]): [name: string, value: string] | [] {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.trim() !== "") return [name, value.trim()];
  }
  return [];
}

/**
 * The standard stream `LOG_STREAM` / `CRAFT_LOG_STREAM` names. Any value
 * other than the two goes to stderr with a note: a typo must not put logs
 * back into the stream the variable exists to keep clean.
 */
function streamFromEnvironment(): "stdout" | "stderr" {
  const [, raw] = firstSet("LOG_STREAM", "CRAFT_LOG_STREAM");
  const stream = raw?.toLowerCase();
  if (stream === undefined || stream === "stdout") return "stdout";
  if (stream !== "stderr") {
    process.stderr.write(
      `LOG_STREAM must be "stdout" or "stderr"; received "${String(raw)}". Logging to stderr.\n`,
    );
  }
  return "stderr";
}

/**
 * The level `LOG_LEVEL` / `CRAFT_LOG_LEVEL` names. A value that is no level
 * is reported and ignored, so a typo cannot stop the process at its first
 * log line.
 */
function levelFromEnvironment(): LogThreshold | undefined {
  const [name, raw] = firstSet("LOG_LEVEL", "CRAFT_LOG_LEVEL");
  if (raw === undefined) return undefined;
  const level = raw.toLowerCase();
  if (isThreshold(level)) return level;
  process.stderr.write(
    `${String(name)} must be one of ${THRESHOLDS.join(", ")}; received "${raw}". Ignored.\n`,
  );
  return undefined;
}

let root: Logger | undefined;

/**
 * The logger used where none was configured: a context without
 * `CraftConfig.logger`, and code that runs outside any context.
 *
 * Built on the first call, not at import, from the environment
 * (`LOG_LEVEL`, `LOG_FILE`, `LOG_STREAM`, `LOG_REDACT`, each also with a
 * `CRAFT_` prefix) over `craft.log.{cjs,js}` (`level`, `file`, `redact`).
 * Lines are pretty-printed when `pino-pretty` is installed, no file is
 * named and `NODE_ENV` is unset or `development`; `PINO_PRETTY=1` asks for
 * that outright.
 *
 * @returns The same logger on every call
 * @throws RC5017 when `PINO_PRETTY` is set and `pino-pretty` is not installed
 */
export function defaultLogger(): Logger {
  if (root !== undefined) return root;
  const fromFile = loadConfigFile();
  const [fileSource, envFile] = firstSet("LOG_FILE", "CRAFT_LOG_FILE");
  const file = envFile ?? fromFile.file;
  const [, envRedact] = firstSet("LOG_REDACT", "CRAFT_LOG_REDACT");
  const redact =
    envRedact !== undefined
      ? envRedact
          .split(",")
          .map((path) => path.trim())
          .filter(Boolean)
      : fromFile.redact;
  const level = levelFromEnvironment() ?? fromFile.level;
  const asked = ["1", "true"].includes(process.env["PINO_PRETTY"] ?? "");
  const nodeEnv = process.env["NODE_ENV"];
  const pretty =
    file === undefined &&
    nodeEnv !== "production" &&
    (asked ||
      nodeEnv === undefined ||
      nodeEnv === "" ||
      nodeEnv === "development");
  root = build(
    {
      stream: streamFromEnvironment(),
      pretty,
      ...(level !== undefined ? { level } : {}),
      ...(file !== undefined ? { file } : {}),
      ...(redact !== undefined ? { redact } : {}),
    },
    (fileSource as LogFileDiversion["source"] | undefined) ?? "craft.log",
    asked,
  );
  return root;
}

function contextBindings(context: CraftContext): Record<string, unknown> {
  const bindings: Record<string, unknown> = { contextId: context.contextId };
  if (context.name !== undefined) bindings["service.name"] = context.name;
  return bindings;
}

/**
 * The bindings a route's or an exchange's logger adds to its context's: the
 * part of {@link childBindings} the context logger does not already carry.
 *
 * @internal
 */
export function scopeBindings(
  scope: Route | Exchange,
): Record<string, unknown> {
  if (isRoute(scope)) return { route: scope.definition.id };
  const bindings: Record<string, unknown> = {
    route: scope.headers[HeadersKeys.ROUTE_ID],
    correlationId: scope.headers[HeadersKeys.CORRELATION_ID],
    exchangeId: scope.id,
  };
  const causationId = scope.headers[HeadersKeys.CAUSATION_ID];
  if (typeof causationId === "string") bindings["causationId"] = causationId;
  // Only subject and issuer are safe for logs; email, name and roles are PII.
  const principal = principalOf(scope);
  if (principal?.subject !== undefined)
    bindings["auth.subject"] = principal.subject;
  if (principal?.issuer !== undefined)
    bindings["auth.issuer"] = principal.issuer;
  return bindings;
}

/**
 * The bindings that place a line: `contextId` and `service.name` for a
 * context, plus `route` for a route, plus `correlationId`, `exchangeId` and
 * the caller's subject and issuer for an exchange. `context.logger`,
 * `route.logger` and `exchange.logger` already carry them; this is for a
 * logger of your own that should read the same.
 *
 * @param context - CraftContext, Route, or Exchange instance
 * @returns The bindings, empty for an exchange that belongs to no context
 *
 * @example
 * ```typescript
 * const audit = createLogger({ file: "audit.log" }).child(childBindings(exchange));
 * audit.info({ decision: "approved" }, "Decision recorded");
 * ```
 */
export function childBindings(
  context: CraftContext | Route | Exchange,
): Record<string, unknown> {
  if (isCraftContext(context)) return contextBindings(context);
  if (isRoute(context)) {
    return { ...contextBindings(context.context), ...scopeBindings(context) };
  }
  if (isExchange(context)) {
    const owner = getExchangeContext(context);
    if (owner) return { ...contextBindings(owner), ...scopeBindings(context) };
  }
  return {};
}
