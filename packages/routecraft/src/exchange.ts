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
  /**
   * Synthetic step inserted by the runtime when a source adapter attaches a
   * `parse` function to the queued message. Runs `exchange.body = parse(body)`
   * before any user steps so parse failures flow through the route's normal
   * error handling instead of aborting the source. See #187.
   */
  PARSE = "parse",
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
  /** Conditionally route the exchange through one of several branches */
  CHOICE = "choice",
  /** Short-circuit the pipeline: drop the exchange without further steps */
  HALT = "halt",
}

/**
 * Standard header keys used in exchanges.
 * These keys provide metadata and context for processing exchanges.
 */
/**
 * Registry of known header keys. Plugins can extend this via module
 * augmentation so that their keys appear in `ExchangeHeaders` autocomplete.
 *
 * @example
 * ```ts
 * // In a plugin package
 * declare module "@routecraft/routecraft" {
 *   interface HeaderKeysRegistry {
 *     MY_KEY: "routecraft.my.key";
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HeaderKeysRegistry {}

/**
 * Standard header keys used in exchanges.
 * These keys provide metadata and context for processing exchanges.
 *
 * Plugins can register additional keys by augmenting the
 * {@link HeaderKeysRegistry} interface.
 */
export const HeadersKeys = {
  /** The operation type (from, process, to) */
  OPERATION: "routecraft.operation",
  /** The route id */
  ROUTE_ID: "routecraft.route",
  /** The correlation id */
  CORRELATION_ID: "routecraft.correlation_id",
  /** The hierarchy of split groups this exchange belongs to */
  SPLIT_HIERARCHY: "routecraft.split_hierarchy",
  /** The exact timestamp when the timer fired, in ISO 8601 format */
  TIMER_TIME: "routecraft.timer.time",
  /** The timestamp when the exchange was created, in ISO 8601 format */
  TIMER_FIRED_TIME: "routecraft.timer.firedTime",
  /** The period in milliseconds between timer firings */
  TIMER_PERIOD_MS: "routecraft.timer.periodMs",
  /** The number of times the timer has fired */
  TIMER_COUNTER: "routecraft.timer.counter",
  /** The next timestamp when the timer will fire, in ISO 8601 format */
  TIMER_NEXT_RUN: "routecraft.timer.nextRun",

  /** The cron expression that triggered this exchange */
  CRON_EXPRESSION: "routecraft.cron.expression",
  /** The timestamp when the cron job fired, in ISO 8601 format */
  CRON_FIRED_TIME: "routecraft.cron.firedTime",
  /** The next timestamp when the cron job will fire, in ISO 8601 format */
  CRON_NEXT_RUN: "routecraft.cron.nextRun",
  /** The number of times the cron job has fired */
  CRON_COUNTER: "routecraft.cron.counter",
  /** The IANA timezone for the cron schedule */
  CRON_TIMEZONE: "routecraft.cron.timezone",
  /** The human-readable name for the cron job */
  CRON_NAME: "routecraft.cron.name",

  /** The 1-based line number when reading a file in chunked mode */
  FILE_LINE: "routecraft.file.line",
  /** The file path when reading a file in chunked mode */
  FILE_PATH: "routecraft.file.path",

  /** The 1-based row number when reading a CSV file in chunked mode */
  CSV_ROW: "routecraft.csv.row",
  /** The file path when reading a CSV file in chunked mode */
  CSV_PATH: "routecraft.csv.path",

  /** The 1-based line number when reading a JSONL file in chunked mode */
  JSONL_LINE: "routecraft.jsonl.line",
  /** The file path when reading a JSONL file in chunked mode */
  JSONL_PATH: "routecraft.jsonl.path",
} as const satisfies Record<string, string>;

/**
 * Standard headers used by the Routecraft framework.
 * These headers provide critical metadata for processing exchanges.
 *
 * Plugins can extend this via module augmentation alongside
 * {@link HeaderKeysRegistry} to add typed headers.
 */
export interface RoutecraftHeaders {
  /** The current operation being performed (OperationType or DSL label) */
  "routecraft.operation": OperationType | string;

  /** The ID of the route processing this exchange */
  "routecraft.route": string;

  /** Unique identifier for correlating related exchanges */
  "routecraft.correlation_id": string;

  /** Hierarchy path for split operations */
  "routecraft.split_hierarchy"?: string[];

  /** Timer-specific headers */
  "routecraft.timer.time"?: string;
  "routecraft.timer.firedTime"?: string;
  "routecraft.timer.periodMs"?: number;
  "routecraft.timer.counter"?: number;
  "routecraft.timer.nextRun"?: string;

  /** Cron-specific headers */
  "routecraft.cron.expression"?: string;
  "routecraft.cron.firedTime"?: string;
  "routecraft.cron.nextRun"?: string;
  "routecraft.cron.counter"?: number;
  "routecraft.cron.timezone"?: string;
  "routecraft.cron.name"?: string;

  /** File chunked-mode headers */
  "routecraft.file.line"?: number;
  "routecraft.file.path"?: string;

  /** CSV chunked-mode headers */
  "routecraft.csv.row"?: number;
  "routecraft.csv.path"?: string;

  /** JSONL chunked-mode headers */
  "routecraft.jsonl.line"?: number;
  "routecraft.jsonl.path"?: string;
}

/**
 * Allowed types for a single header value. Custom headers can use any of these; standard headers use specific types (see RoutecraftHeaders).
 */
export type HeaderValue = string | number | boolean | undefined | string[];

/**
 * Mapped type that surfaces keys declared via {@link HeaderKeysRegistry}
 * as optional header properties. Plugins that augment `HeaderKeysRegistry`
 * get autocomplete and type-checking on `exchange.headers`.
 */
type RegistryHeaders = {
  [K in keyof HeaderKeysRegistry as HeaderKeysRegistry[K] extends string
    ? HeaderKeysRegistry[K]
    : never]?: HeaderValue;
};

/**
 * Complete set of headers for an exchange.
 * Includes standard Routecraft headers, plugin-registered headers, and custom headers.
 */
export type ExchangeHeaders = Partial<RoutecraftHeaders> &
  RegistryHeaders &
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
  /**
   * Optional parser the runtime applies as a synthetic first pipeline step.
   * Set by `DefaultRoute` from the queue `Message.parse` when a source
   * adapter attaches one (see `CallableSource.handler` parse argument and
   * #187). The runtime clears this after running it so it does not run
   * twice.
   *
   * @internal
   */
  parse?: (raw: unknown) => unknown | Promise<unknown>;
  /**
   * Optional input-schema validation deferred to run inside the synthetic
   * parse step. Used when a route has both `.input()` schemas and a
   * parsing source: validation must see the parsed body, not the raw
   * bytes. `DefaultRoute` populates this alongside `parse`. See #187.
   *
   * @internal
   */
  applyValidation?: (exchange: Exchange) => Promise<void>;
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
