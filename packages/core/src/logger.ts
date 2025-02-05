import { pino, type Logger } from "pino";
import { type Route, DefaultRoute } from "./route.ts";
import { type Exchange, DefaultExchange, HeadersKeys } from "./exchange.ts";
import { CraftContext } from "./context.ts";
export type { Logger };

const isDev = process.env["NODE_ENV"] !== "production";

const base = pino({
  level: process.env["LOG_LEVEL"] || "info", // Support dynamic log levels
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

export const logger = createLogger();
