import { createRequire } from "node:module";
import { mkdirSync, openSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, isAbsolute, basename } from "node:path";
import { homedir } from "node:os";
import { pino } from "pino";
import { type Route } from "./route.ts";
import { type Exchange, getExchangeContext, HeadersKeys } from "./exchange.ts";
import { isCraftContext, isRoute, isExchange } from "./brand.ts";
import type { CraftContext } from "./context.ts";

const require = createRequire(import.meta.url);

/** Pino options shape we support from config files; env overrides applied on top. */
type PinoOptionsLike = {
  level?: string;
  redact?: string[];
  [key: string]: unknown;
};

/**
 * Load config from first existing file: cwd/craft.log.{cjs,js}, then ~/.routecraft/craft.log.{cjs,js}.
 * Returns plain object; never throws (returns {} if no file or invalid).
 */
function loadConfigFile(): PinoOptionsLike {
  const cwd = process.cwd();
  const home = homedir();
  const dirs = [cwd, resolve(home, ".routecraft")];
  const names = ["craft.log.cjs", "craft.log.js"];
  for (const dir of dirs) {
    for (const name of names) {
      const path = resolve(dir, name);
      if (existsSync(path)) {
        try {
          const mod = require(path);
          const config = mod?.default ?? mod;
          if (config && typeof config === "object") {
            return { ...config };
          }
        } catch {
          // ignore invalid or missing export
        }
      }
    }
  }
  return {};
}

/**
 * Resolve destination stream. ENV wins, then config file, then stdout.
 * Aligns with pino's default and 12-factor. Adapters that own stdout
 * (e.g. MCP stdio) must redirect logs via --log-file or --log-level silent.
 */
function getDestination(fileConfig?: string): NodeJS.WritableStream {
  const pinoDest = pino as unknown as {
    destination: (pathOrFd: string | number) => NodeJS.WritableStream;
  };
  const logFile =
    process.env["LOG_FILE"] ?? process.env["CRAFT_LOG_FILE"] ?? fileConfig;
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
        // User asked for "not stdout" via --log-file; honour that even when
        // both file paths fail. Fall back to stderr rather than violating the
        // flag's contract (e.g. corrupting an MCP stdio protocol stream).
        return pinoDest.destination(2);
      }
    }
  }
  return pinoDest.destination(1);
}

/** Options object accepted by pino() */
type PinoOptions = Parameters<typeof pino>[0];

/**
 * Use pretty (pino-pretty) when NODE_ENV is not production and we're writing to stdout.
 * Override with PINO_PRETTY=1 to force pretty; set LOG_FILE to get JSON (e.g. for MCP).
 */
function usePrettyOutput(filePath?: string): boolean {
  const hasLogFile =
    process.env["LOG_FILE"] ?? process.env["CRAFT_LOG_FILE"] ?? filePath;
  if (hasLogFile) return false;
  const nodeEnv = process.env["NODE_ENV"];
  if (nodeEnv === "production") return false;
  const explicit =
    process.env["PINO_PRETTY"] === "1" || process.env["PINO_PRETTY"] === "true";
  return nodeEnv === "development" || !nodeEnv || explicit;
}

/**
 * Resolve final pino options: config file base, then env overrides (env always wins).
 */
function resolveConfig(): {
  options: PinoOptions;
  destination: NodeJS.WritableStream | undefined;
} {
  const fromFile = loadConfigFile();
  const level =
    process.env["LOG_LEVEL"] ??
    process.env["CRAFT_LOG_LEVEL"] ??
    fromFile.level ??
    "warn";
  const redactEnv =
    process.env["LOG_REDACT"] ?? process.env["CRAFT_LOG_REDACT"];
  const redact = redactEnv
    ? redactEnv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : fromFile.redact;
  const filePath =
    typeof fromFile["file"] === "string" ? fromFile["file"] : undefined;
  const usePretty = usePrettyOutput(filePath);
  const destination = usePretty ? undefined : getDestination(filePath);

  const options: PinoOptions = {
    ...fromFile,
    level,
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
    ...(redact && redact.length > 0 ? { redact } : {}),
    ...(usePretty
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true },
          },
        }
      : {}),
  };

  return { options, destination };
}

const { options, destination } = resolveConfig();
/**
 * Framework-level pino logger instance. Configured via craft.log.{cjs,js} or environment variables.
 */
export const logger =
  destination !== undefined ? pino(options, destination) : pino(options);

/**
 * Returns pino child logger bindings for the given context so logs include contextId, route, exchangeId, etc.
 *
 * @param context - CraftContext, Route, or Exchange instance
 * @returns Object of key-value bindings (e.g. { contextId, route, correlationId, exchangeId })
 *
 * @example
 * ```typescript
 * const child = logger.child(childBindings(exchange));
 * child.info({ extra: 1 }, 'Processing');
 * ```
 */
export function childBindings(
  context: CraftContext | Route | Exchange,
): Record<string, unknown> {
  if (isCraftContext(context)) {
    const ctx = context as CraftContext;
    return { contextId: ctx.contextId };
  }
  if (isRoute(context)) {
    const route = context as Route;
    return {
      contextId: route.context.contextId,
      route: route.definition.id,
    };
  }
  if (isExchange(context)) {
    const ex = context as Exchange;
    const ctx = getExchangeContext(ex);
    if (ctx) {
      const bindings: Record<string, unknown> = {
        contextId: ctx.contextId,
        route: ex.headers[HeadersKeys.ROUTE_ID],
        correlationId: ex.headers[HeadersKeys.CORRELATION_ID],
        exchangeId: ex.id,
      };

      // Include non-PII auth identifiers from exchange headers when
      // present. Only subject and issuer are safe for logs; fields like
      // email, name, and roles are omitted to avoid leaking PII.
      const sub = ex.headers["routecraft.auth.subject"];
      if (sub !== undefined) bindings["auth.subject"] = sub;
      const iss = ex.headers["routecraft.auth.issuer"];
      if (iss !== undefined) bindings["auth.issuer"] = iss;

      return bindings;
    }
  }
  return {};
}
