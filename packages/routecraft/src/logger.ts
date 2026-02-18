import { mkdirSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, isAbsolute, basename } from "node:path";
import { pino, type Logger } from "pino";
import { type Route, DefaultRoute } from "./route.ts";
import { type Exchange, EXCHANGE_INTERNALS, HeadersKeys } from "./exchange.ts";
import { CraftContext } from "./context.ts";

/**
 * Public logger type for RouteCraft. Implemented by the default logger and
 * context/route/exchange loggers. Allows swapping the underlying implementation
 * (e.g. pino) without API changes.
 */
export interface RouteCraftLogger {
  child(bindings: Record<string, unknown>): RouteCraftLogger;

  trace(obj: unknown, msg?: string, ...args: unknown[]): void;
  trace(msg: string, ...args: unknown[]): void;
  debug(obj: unknown, msg?: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  info(obj: unknown, msg?: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(obj: unknown, msg?: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(obj: unknown, msg?: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  fatal(obj: unknown, msg?: string, ...args: unknown[]): void;
  fatal(msg: string, ...args: unknown[]): void;
  silent(msg: string, ...args: unknown[]): void;

  level: string;
  isLevelEnabled(level: string): boolean;
  flush(): void;
}

/** Options applied before the base logger is created (e.g. from CLI or config). */
let pendingLogOptions: {
  logFile?: string;
  level?: string;
  redact?: string[];
} = {};

/**
 * Configure the logger before first use. Call this (e.g. from the CLI or
 * CraftContext) when you have a log file path, level, and/or redact paths from config or env.
 * If the base logger is already created, this has no effect and a warning is emitted.
 *
 * Precedence: CLI runs merge config with argv and call this once (CLI wins). Programmatic
 * context passes config.log; logger then resolves each key as pending > env > default.
 *
 * Redaction uses pino's `redact` option (paths like `user.name`, `req.headers.authorization`).
 * You can also set comma-separated paths via LOG_REDACT or CRAFT_LOG_REDACT; config takes precedence.
 */
export function configureLogger(options: {
  logFile?: string;
  level?: string;
  redact?: string[];
}): void {
  if (base !== null) {
    const msg =
      "configureLogger was called after the logger was initialized; the provided logFile and options will be ignored.";
    try {
      base.warn(msg);
    } catch {
      process.stderr.write(`${msg}\n`);
    }
    return;
  }
  if (options.logFile !== undefined) {
    pendingLogOptions = { ...pendingLogOptions, logFile: options.logFile };
  }
  if (options.level !== undefined) {
    pendingLogOptions = { ...pendingLogOptions, level: options.level };
  }
  if (options.redact !== undefined) {
    pendingLogOptions = { ...pendingLogOptions, redact: options.redact };
  }
}

/** Detect development environment for logger configuration */
const isDev = process.env["NODE_ENV"] !== "production";

/**
 * Check if pino-pretty is available (installed as a devDependency)
 */
function hasPinoPretty(): boolean {
  try {
    import.meta.resolve?.("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve log destination. Precedence: (1) pendingLogOptions.logFile (CLI
 * --log-file / config), (2) process.env.LOG_FILE, (3) process.env.CRAFT_LOG_FILE.
 * If none are set, returns stdout (fd 1). For file logging we open the fd once
 * and pass it to pino so sonic-boom is ready immediately, avoiding "sonic boom
 * is not ready yet" when the process exits early. On EROFS/EACCES falls back to
 * os.tmpdir() or stdout.
 */
function getLogDestination(): NodeJS.WritableStream {
  const pinoDest = pino as unknown as {
    destination: (pathOrFd: string | number) => NodeJS.WritableStream;
  };
  const logFile =
    pendingLogOptions.logFile ??
    process.env["LOG_FILE"] ??
    process.env["CRAFT_LOG_FILE"];
  if (logFile) {
    const resolved = isAbsolute(logFile)
      ? logFile
      : resolve(process.cwd(), logFile);
    try {
      mkdirSync(dirname(resolved), { recursive: true });
      const fd = openSync(resolved, "a");
      return pinoDest.destination(fd);
    } catch {
      try {
        const pathToUse = resolve(tmpdir(), basename(logFile));
        const fd = openSync(pathToUse, "a");
        return pinoDest.destination(fd);
      } catch {
        return pinoDest.destination(1);
      }
    }
  }
  return pinoDest.destination(1);
}

let base: Logger | null = null;

/**
 * Resolve redact paths: config (configureLogger / craftConfig.log.redact) takes precedence,
 * then LOG_REDACT or CRAFT_LOG_REDACT (comma-separated). Used so redaction is configurable
 * without a CLI flag.
 */
function getRedactPaths(): string[] | undefined {
  const fromConfig = pendingLogOptions.redact;
  if (fromConfig !== undefined && fromConfig.length > 0) {
    return fromConfig;
  }
  const env = process.env["LOG_REDACT"] ?? process.env["CRAFT_LOG_REDACT"];
  if (env) {
    return env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return undefined;
}

/**
 * Base logger (lazy-initialized so LOG_FILE / LOG_LEVEL / configureLogger can be
 * applied after env is loaded). Logs to stdout by default at warn level; set
 * LOG_FILE or --log-file to log to a file (e.g. for MCP stdio).
 */
function getBaseLogger(): Logger {
  if (base !== null) {
    return base;
  }
  const destination = getLogDestination();
  const destFd = destination as { fd?: number };
  const isStdout = destFd.fd === 1;
  const redact = getRedactPaths();
  const pinoLogger = pino(
    {
      level:
        pendingLogOptions.level ??
        process.env["LOG_LEVEL"] ??
        process.env["CRAFT_LOG_LEVEL"] ??
        "warn",
      formatters: {
        level: (label) => ({ level: label.toUpperCase() }),
      },
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      ...(redact !== undefined && redact.length > 0 ? { redact } : {}),
      ...(isDev && isStdout && hasPinoPretty()
        ? {
            transport: {
              target: "pino-pretty",
              options: {
                destination: 1,
                colorize: true,
                ignore:
                  "pid,hostname,contextId,exchangeId,correlationId,routeId",
                translateTime: "HH:MM:ss.l",
                messageFormat: "[{routeId}] {msg}",
              },
            },
          }
        : {}),
    },
    destination,
  );
  // Wrap so tests that vi.spyOn(logger, 'child') have the mock used by createLogger() too.
  base = new Proxy(pinoLogger, {
    get(target, prop) {
      if (prop === "child" && loggerOverrides.has("child")) {
        return loggerOverrides.get("child");
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[
        prop
      ];
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  }) as Logger;
  return base;
}

/**
 * Create a context-aware logger with appropriate metadata.
 *
 * This function creates a logger that includes relevant context information:
 * - For CraftContext: Includes contextId
 * - For Route: Includes contextId and routeId
 * - For Exchange: Includes contextId, routeId, exchangeId, and correlationId
 *
 * @param context The context to create a logger for
 * @returns A configured logger instance
 *
 * @example
 * ```typescript
 * // Create a logger for a context
 * const contextLogger = createLogger(myContext);
 * contextLogger.info('Context starting');
 *
 * // Create a logger for a route
 * const routeLogger = createLogger(myRoute);
 * routeLogger.debug('Processing route');
 *
 * // Create a logger for an exchange
 * const exchangeLogger = createLogger(exchange);
 * exchangeLogger.info('Processing data', { data: exchange.body });
 * ```
 */
export function createLogger(
  context?: CraftContext | Route | Exchange,
): RouteCraftLogger {
  const b = getBaseLogger();
  if (!context) {
    return b as unknown as RouteCraftLogger;
  }

  if (context instanceof CraftContext) {
    return b.child({
      contextId: context.contextId,
    }) as unknown as RouteCraftLogger;
  } else if (context instanceof DefaultRoute) {
    return b.child({
      contextId: context.context.contextId,
      routeId: context.definition.id,
    }) as unknown as RouteCraftLogger;
  } else if (EXCHANGE_INTERNALS.has(context as Exchange)) {
    const internals = EXCHANGE_INTERNALS.get(context as Exchange)!;
    return b.child({
      contextId: internals.context.contextId,
      routeId: (context as Exchange).headers[HeadersKeys.ROUTE_ID],
      exchangeId: (context as Exchange).id,
      correlationId: (context as Exchange).headers[HeadersKeys.CORRELATION_ID],
    }) as unknown as RouteCraftLogger;
  } else {
    return b as unknown as RouteCraftLogger;
  }
}

/** Overrides for the default logger (e.g. tests setting logger.child). */
const loggerOverrides = new Map<string | symbol, unknown>();

/**
 * Default global logger instance (lazy: base logger is created on first use).
 * This allows configureLogger() to be called before any log call (e.g. CLI merges
 * config with argv and calls configureLogger before the first logger.info).
 *
 * Use this for application-level logging when no specific context is available.
 * For context-specific logging, create a logger using createLogger().
 *
 * @example
 * ```typescript
 * // Log application-level messages
 * logger.info('Application starting');
 * logger.error(error, 'Unexpected error occurred');
 * ```
 */
function getDefaultLogger(): RouteCraftLogger {
  return createLogger();
}

/** Props on RouteCraftLogger so vi.spyOn(logger, prop) can see them. */
const LOGGER_PROPS = new Set<string>([
  "child",
  "level",
  "isLevelEnabled",
  "flush",
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
]);

export const logger: RouteCraftLogger = new Proxy({} as RouteCraftLogger, {
  get(_target, prop) {
    const overridden = loggerOverrides.get(prop);
    if (overridden !== undefined) {
      return overridden;
    }
    const target = getDefaultLogger();
    const value = (target as unknown as Record<string | symbol, unknown>)[prop];
    if (typeof value === "function") {
      return value.bind(target);
    }
    return value;
  },
  set(_target, prop, value) {
    loggerOverrides.set(prop, value);
    return true;
  },
  deleteProperty(_target, prop) {
    loggerOverrides.delete(prop);
    return true;
  },
  has(_target, prop) {
    return (
      loggerOverrides.has(prop) ||
      LOGGER_PROPS.has(String(prop)) ||
      (typeof prop === "string" && prop in getDefaultLogger())
    );
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (loggerOverrides.has(prop)) {
      return {
        value: loggerOverrides.get(prop),
        configurable: true,
        enumerable: true,
        writable: true,
      };
    }
    const target = getDefaultLogger();
    const value = (target as unknown as Record<string | symbol, unknown>)[prop];
    if (
      value !== undefined &&
      (LOGGER_PROPS.has(String(prop)) ||
        (typeof prop === "string" && prop in target))
    ) {
      return {
        value: typeof value === "function" ? value.bind(target) : value,
        configurable: true,
        enumerable: true,
        writable: true,
      };
    }
    return undefined;
  },
  defineProperty(_target, prop, descriptor) {
    if ("value" in descriptor) {
      loggerOverrides.set(prop, descriptor.value);
    }
    return true;
  },
});
