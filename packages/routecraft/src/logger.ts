import { pino, type Logger } from "pino";
import { type Route, DefaultRoute } from "./route.ts";
import { type Exchange, DefaultExchange, HeadersKeys } from "./exchange.ts";
import { CraftContext } from "./context.ts";
export type { Logger };

/** Detect development environment for logger configuration */
const isDev = process.env["NODE_ENV"] !== "production";

/**
 * Base logger configuration with reasonable defaults.
 * In development, uses pino-pretty for readable logs.
 * In production, uses standard JSON format for machine processing.
 */
const base = pino({
  level: process.env["LOG_LEVEL"] || "warn", // Support dynamic log levels
  formatters: {
    level: (label) => ({ level: label.toUpperCase() }), // Ensure consistent casing
  },
  timestamp: pino.stdTimeFunctions.isoTime, // Use ISO timestamp format
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            ignore: "pid,hostname",
            translateTime: "SYS:standard",
          },
        },
      }
    : {}),
});

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
  if (!context) {
    return base;
  }

  if (context instanceof CraftContext) {
    return base.child({
      contextId: context.contextId,
    });
  } else if (context instanceof DefaultRoute) {
    return base.child({
      contextId: context.context.contextId,
      routeId: context.definition.id,
    });
  } else if (context instanceof DefaultExchange) {
    return base.child({
      contextId: context.context.contextId,
      routeId: context.headers[HeadersKeys.ROUTE_ID],
      exchangeId: context.id,
      correlationId: context.headers[HeadersKeys.CORRELATION_ID],
    });
  } else {
    return base;
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
