import { CraftContext } from "./context.ts";
import { type Logger, createLogger } from "./logger.ts";

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
}

/**
 * Standard headers used by the Routecraft framework.
 * These headers provide critical metadata for processing exchanges.
 */
export interface RouteCraftHeaders {
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
}

/**
 * Possible types for header values.
 */
export type HeaderValue = string | number | boolean | undefined | string[];

/**
 * Complete set of headers for an exchange.
 * Includes both standard Routecraft headers and custom headers.
 */
export type ExchangeHeaders = Partial<RouteCraftHeaders> &
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

  /** Logger for this exchange */
  logger: Logger;
};

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

  /** Logger for this exchange */
  public readonly logger: Logger;

  /**
   * Create a new exchange.
   *
   * @param context The CraftContext this exchange belongs to
   * @param options Optional configuration for the exchange
   */
  constructor(
    public readonly context: CraftContext,
    options?: Partial<Exchange<T>>,
  ) {
    this.id = options?.id || crypto.randomUUID();
    this.headers = {
      [HeadersKeys.ROUTE_ID]: crypto.randomUUID(),
      [HeadersKeys.OPERATION]: OperationType.FROM,
      [HeadersKeys.CORRELATION_ID]: crypto.randomUUID(),
      ...(options?.headers || {}),
    };
    this.body = options?.body || ({} as T);
    this.logger = createLogger(this);
  }
}
