import { closeSync, mkdirSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, isAbsolute, basename } from "node:path";
import { pino, type Logger } from "pino";
import { type Route, DefaultRoute } from "./route.ts";
import { type Exchange, EXCHANGE_INTERNALS, HeadersKeys } from "./exchange.ts";
import { CraftContext } from "./context.ts";
export type { Logger };

/** Options applied before the base logger is created (e.g. from CLI or config). */
let pendingLogOptions: { logFile?: string; level?: string } = {};

/**
 * Configure the logger before first use. Call this (e.g. from the CLI or
 * CraftContext) when you have a log file path and/or level from config or env.
 * If the base logger is already created, this has no effect and a warning is emitted.
 */
export function configureLogger(options: {
  logFile?: string;
  level?: string;
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
 * If none are set, returns stdout (fd 1). No file is opened unless one of these
 * is set. On EROFS/EACCES falls back to os.tmpdir() or stdout.
 */
function getLogDestination(): NodeJS.WritableStream {
  const logFile =
    pendingLogOptions.logFile ??
    process.env["LOG_FILE"] ??
    process.env["CRAFT_LOG_FILE"];
  if (logFile) {
    const resolved = isAbsolute(logFile)
      ? logFile
      : resolve(process.cwd(), logFile);
    let pathToUse = resolved;
    try {
      mkdirSync(dirname(resolved), { recursive: true });
      const fd = openSync(resolved, "a");
      closeSync(fd);
    } catch {
      pathToUse = resolve(tmpdir(), basename(logFile));
      try {
        const fd = openSync(pathToUse, "a");
        closeSync(fd);
      } catch {
        // fall back to stdout if tmp is also unwritable
        return (
          pino as unknown as {
            destination: (fd: number) => NodeJS.WritableStream;
          }
        ).destination(1);
      }
    }
    return (
      pino as unknown as {
        destination: (path: string) => NodeJS.WritableStream;
      }
    ).destination(pathToUse);
  }
  return (
    pino as unknown as { destination: (fd: number) => NodeJS.WritableStream }
  ).destination(1);
}

let base: Logger | null = null;

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
  base = pino(
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
): Logger {
  const b = getBaseLogger();
  if (!context) {
    return b;
  }

  if (context instanceof CraftContext) {
    return b.child({
      contextId: context.contextId,
    });
  } else if (context instanceof DefaultRoute) {
    return b.child({
      contextId: context.context.contextId,
      routeId: context.definition.id,
    });
  } else if (EXCHANGE_INTERNALS.has(context as Exchange)) {
    const internals = EXCHANGE_INTERNALS.get(context as Exchange)!;
    return b.child({
      contextId: internals.context.contextId,
      routeId: (context as Exchange).headers[HeadersKeys.ROUTE_ID],
      exchangeId: (context as Exchange).id,
      correlationId: (context as Exchange).headers[HeadersKeys.CORRELATION_ID],
    });
  } else {
    return b;
  }
}

/**
 * Default global logger instance.
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
export const logger = createLogger();
