import { randomUUID } from "node:crypto";
import { INTERNALS_KEY, BRAND, setBrand, setInternals } from "./brand.ts";
import { type CraftContext } from "./context.ts";
import { logger, childBindings } from "./logger.ts";
import type { Route } from "./route.ts";

/**
 * Types of operations that can be performed on an exchange.
 * These values are used in exchange headers to track the current operation.
 */
export enum OperationType {
  /** The exchange was created from a source */
  FROM = "from",
  /** The exchange was processed by a processor */
  PROCESS = "process",
  /** The exchange was sent to a destination */
  TO = "to",
  /** The exchange was split into multiple exchanges */
  SPLIT = "split",
  /** The exchange was aggregated from multiple exchanges */
  AGGREGATE = "aggregate",
  /** Modify the body of the exchange */
  TRANSFORM = "transform",
  /** Tap an exchange without modifying it */
  TAP = "tap",
  /** Filter an exchange based on a condition and reject the message if the condition is not met */
  FILTER = "filter",
  /** Validate the exchange against a schema and reject the message if the schema is not met */
  VALIDATE = "validate",
  /** Enrich the exchange with data from another exchange */
  ENRICH = "enrich",
  /** Set or override a header on the exchange */
  HEADER = "header",
}

/**
 * Standard header keys used in exchanges.
 * These keys provide metadata and context for processing exchanges.
 */
export enum HeadersKeys {
  /** The operation type (from, process, to) */
  OPERATION = "routecraft.operation",
  /** The route id */
  ROUTE_ID = "routecraft.route",
  /** The correlation id */
  CORRELATION_ID = "routecraft.correlation_id",
  /** The hierarchy of split groups this exchange belongs to */
  SPLIT_HIERARCHY = "routecraft.split_hierarchy",
  /** The exact timestamp when the timer fired, in ISO 8601 format */
  TIMER_TIME = "routecraft.timer.time",
  /** The timestamp when the exchange was created, in ISO 8601 format */
  TIMER_FIRED_TIME = "routecraft.timer.firedTime",
  /** The period in milliseconds between timer firings */
  TIMER_PERIOD_MS = "routecraft.timer.periodMs",
  /** The number of times the timer has fired */
  TIMER_COUNTER = "routecraft.timer.counter",
  /** The next timestamp when the timer will fire, in ISO 8601 format */
  TIMER_NEXT_RUN = "routecraft.timer.nextRun",

  /** The cron expression that triggered this exchange */
  CRON_EXPRESSION = "routecraft.cron.expression",
  /** The timestamp when the cron job fired, in ISO 8601 format */
  CRON_FIRED_TIME = "routecraft.cron.firedTime",
  /** The next timestamp when the cron job will fire, in ISO 8601 format */
  CRON_NEXT_RUN = "routecraft.cron.nextRun",
  /** The number of times the cron job has fired */
  CRON_COUNTER = "routecraft.cron.counter",
  /** The IANA timezone for the cron schedule */
  CRON_TIMEZONE = "routecraft.cron.timezone",
  /** The human-readable name for the cron job */
  CRON_NAME = "routecraft.cron.name",
}

/**
 * Standard headers used by the Routecraft framework.
 * These headers provide critical metadata for processing exchanges.
 */
export interface RoutecraftHeaders {
  /** The current operation being performed */
  [HeadersKeys.OPERATION]: OperationType;

  /** The ID of the route processing this exchange */
  [HeadersKeys.ROUTE_ID]: string;

  /** Unique identifier for correlating related exchanges */
  [HeadersKeys.CORRELATION_ID]: string;

  /** Hierarchy path for split operations */
  [HeadersKeys.SPLIT_HIERARCHY]?: string[];

  /** Timer-specific headers */
  [HeadersKeys.TIMER_TIME]?: string;
  [HeadersKeys.TIMER_FIRED_TIME]?: string;
  [HeadersKeys.TIMER_PERIOD_MS]?: number;
  [HeadersKeys.TIMER_COUNTER]?: number;
  [HeadersKeys.TIMER_NEXT_RUN]?: string;

  /** Cron-specific headers */
  [HeadersKeys.CRON_EXPRESSION]?: string;
  [HeadersKeys.CRON_FIRED_TIME]?: string;
  [HeadersKeys.CRON_NEXT_RUN]?: string;
  [HeadersKeys.CRON_COUNTER]?: number;
  [HeadersKeys.CRON_TIMEZONE]?: string;
  [HeadersKeys.CRON_NAME]?: string;
}

/**
 * Allowed types for a single header value. Custom headers can use any of these; standard headers use specific types (see RoutecraftHeaders).
 */
export type HeaderValue = string | number | boolean | undefined | string[];

/**
 * Complete set of headers for an exchange.
 * Includes both standard Routecraft headers and custom headers.
 */
export type ExchangeHeaders = Partial<RoutecraftHeaders> &
  Record<string, HeaderValue>;

/**
 * Represents a message being processed through a route.
 *
 * An exchange encapsulates:
 * - The data being processed (body)
 * - Metadata about the processing (headers)
 * - A unique identifier
 * - Logging capabilities
 *
 * @template T The type of data in the body
 */
export type Exchange<T = unknown> = {
  /** Unique identifier for this exchange */
  readonly id: string;

  /** Headers containing metadata */
  readonly headers: ExchangeHeaders;

  /** The data being processed */
  body: T;

  /** Logger for this exchange (pino child logger) */
  logger: ReturnType<typeof logger.child>;
};

/**
 * Internal state for exchanges.
 * Stored in WeakMap so it is not exposed on the public Exchange interface.
 *
 * @internal
 */
type ExchangeInternals = {
  context: CraftContext;
  route?: Route;
};

/**
 * WeakMap storing internal state for exchanges.
 * Used to hide context and task tracking from external access.
 *
 * @internal
 */
export const EXCHANGE_INTERNALS = new WeakMap<Exchange, ExchangeInternals>();

/**
 * Get the CraftContext for an exchange, if it has internals.
 * Reads from symbol-keyed storage first (cross-instance safe), then WeakMap.
 *
 * @param exchange The exchange
 * @returns The context or undefined
 * @internal
 */
export function getExchangeContext(
  exchange: Exchange,
): CraftContext | undefined {
  const internals =
    (exchange as Exchange & { [INTERNALS_KEY]?: ExchangeInternals })[
      INTERNALS_KEY
    ] ?? EXCHANGE_INTERNALS.get(exchange);
  return internals?.context;
}

/**
 * Get the route for an exchange, if it has internals.
 * Reads from symbol-keyed storage first (cross-instance safe), then WeakMap.
 *
 * @param exchange The exchange
 * @returns The route or undefined
 * @internal
 */
export function getExchangeRoute(exchange: Exchange): Route | undefined {
  const internals =
    (exchange as Exchange & { [INTERNALS_KEY]?: ExchangeInternals })[
      INTERNALS_KEY
    ] ?? EXCHANGE_INTERNALS.get(exchange);
  return internals?.route;
}

/**
 * Default implementation of the Exchange interface.
 *
 * Provides standard exchange functionality with automatic
 * ID generation and header initialization.
 *
 * @template T The type of data in the body
 *
 * @example
 * ```typescript
 * // Create a simple exchange with a string body
 * const exchange = new DefaultExchange<string>(context, {
 *   body: "Hello, World!"
 * });
 *
 * // Access exchange properties
 * console.log(exchange.id);        // Unique UUID
 * console.log(exchange.body);      // "Hello, World!"
 * console.log(exchange.headers);   // Headers object with standard fields
 * ```
 */
export class DefaultExchange<T = unknown> implements Exchange<T> {
  /** Unique identifier for this exchange */
  readonly id: string;

  /** Headers containing metadata */
  readonly headers: ExchangeHeaders;

  /** The data being processed */
  body: T;

  /** Logger for this exchange (pino child logger) */
  public readonly logger: ReturnType<typeof logger.child>;

  /**
   * Create a new exchange.
   *
   * @param context The CraftContext this exchange belongs to
   * @param options Optional configuration for the exchange
   */
  constructor(context: CraftContext, options?: Partial<Exchange<T>>) {
    this.id = options?.id || randomUUID();
    this.headers = {
      [HeadersKeys.ROUTE_ID]: randomUUID(),
      [HeadersKeys.OPERATION]: OperationType.FROM,
      [HeadersKeys.CORRELATION_ID]: randomUUID(),
      ...(options?.headers || {}),
    };
    this.body = options?.body || ({} as T);

    // Store internals: symbol key (cross-instance) and WeakMap (same-instance compat)
    const internals: ExchangeInternals = { context };
    setInternals(this, INTERNALS_KEY, internals);
    EXCHANGE_INTERNALS.set(this, internals);
    setBrand(this, BRAND.Exchange);
    this.logger = logger.child(childBindings(this));
  }
}
