import { randomUUID } from "node:crypto";
import { INTERNALS_KEY, BRAND, setBrand, setInternals } from "./brand.ts";
import { type CraftContext } from "./context.ts";
import { logger, childBindings } from "./logger.ts";
import type { Route } from "./route.ts";
import type { OnParseError } from "./adapters/shared/parse.ts";
import type { Principal } from "./auth/types.ts";

/**
 * Types of operations that can be performed on an exchange.
 * These values are used in exchange headers to track the current operation.
 */
export enum OperationType {
  /** The exchange was created from a source */
  FROM = "from",
  /**
   * Synthetic step inserted by the runtime when a source adapter attaches a
   * `parse` function to the queued message. Builds a derived exchange via
   * `DefaultExchange.rewrap(exchange, { body: await parse(exchange.body) })`
   * before any user steps so parse failures flow through the route's normal
   * error handling instead of aborting the source. See #187.
   *
   * @experimental Tracks `OnParseError`'s maturity.
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
 * Complete set of headers for an exchange. Read-only by contract: produce
 * derived headers via spread (`{ ...exchange.headers, key: value }`) and the
 * framework re-wraps the resulting exchange when the operation hands it back.
 *
 * Includes standard Routecraft headers, plugin-registered headers, and
 * custom headers.
 */
export type ExchangeHeaders = Readonly<
  Partial<RoutecraftHeaders> & RegistryHeaders & Record<string, HeaderValue>
>;

/**
 * Represents a message being processed through a route.
 *
 * An exchange encapsulates:
 * - The data being processed (body)
 * - Metadata about the processing (headers)
 * - A unique identifier
 * - Logging capabilities
 * - The authenticated principal, if any (set at the source boundary by
 *   adapters that perform authentication, or in a route step via
 *   `.process()` when callers want to attach a custom identity)
 *
 * Exchanges are immutable. Operations that change body, headers, or
 * principal must produce a new exchange (typically via spread) and return
 * it; the framework re-wraps the result via {@link DefaultExchange.rewrap}
 * so it preserves internal bindings (context, route). Body is not deep-
 * frozen so adapter authors can attach arbitrary user payloads, but the
 * framework will not mutate it and authors should treat it the same way.
 *
 * @template T The type of data in the body
 */
export type Exchange<T = unknown> = {
  /** Unique identifier for this exchange */
  readonly id: string;

  /** Headers containing metadata */
  readonly headers: ExchangeHeaders;

  /** The data being processed */
  readonly body: T;

  /**
   * Authenticated principal for this exchange, when one has been resolved.
   *
   * Set automatically by source adapters that perform authentication (e.g.
   * the MCP server when `auth:` is configured). Routes may also assign a
   * custom principal in `.process()` to attribute downstream actions to a
   * specific identity (for example, mapping the sender of an inbound email
   * onto a `kind: "custom"` principal).
   *
   * Operations that re-stitch exchanges (`process`, `split`, `aggregate`,
   * `enrich`, `tap`) propagate the principal with `?? current` semantics:
   * a returned exchange that omits a principal inherits the parent's,
   * rather than clearing it. The `| undefined` in the type lets callers
   * pass `undefined` through `Partial<Exchange>` constructor options
   * under `exactOptionalPropertyTypes`; it does NOT mean an assignment of
   * `undefined` clears the field downstream.
   *
   * @experimental
   */
  readonly principal?: Principal | undefined;

  /** Logger for this exchange (pino child logger) */
  readonly logger: ReturnType<typeof logger.child>;
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
   * How the synthetic parse step should handle a parse failure.
   * - `"fail"` / `"abort"`: throw `RC5016` so `exchange:failed` fires (and
   *   for `"abort"` the adapter rethrows out of subscribe).
   * - `"drop"`: emit `exchange:dropped` with `reason: "parse-failed"`,
   *   matching filter/validate drop semantics; the pipeline halts cleanly
   *   without invoking `.error()`. See #187.
   *
   * @internal
   */
  parseFailureMode?: OnParseError;
  /**
   * Optional input-schema validation deferred to run inside the synthetic
   * parse step. Used when a route has both `.input()` schemas and a
   * parsing source: validation must see the parsed body, not the raw
   * bytes. `DefaultRoute` populates this alongside `parse`. See #187.
   *
   * Returns the validated exchange (with body and/or headers updated)
   * so the parse step can thread the new immutable instance forward.
   *
   * @internal
   */
  applyValidation?: (exchange: Exchange) => Promise<Exchange>;
  /**
   * When the engine first encounters an exchange in the step loop it
   * records the start timestamp here, used later to compute duration
   * for `exchange:completed`. Stored on internals (rather than headers)
   * so it survives `rewrap` calls without consuming a header slot, and
   * so aggregator code can read child start times without the engine
   * having to thread a side-Map through.
   *
   * @internal
   */
  startedAt?: number;
  /**
   * Set by filter, choice (halt + unmatched), and the synthetic parse
   * step when an exchange is dropped. The runtime engine reads this
   * after `runSteps` completes to skip `exchange:completed` emission.
   * Stored on internals so the flag survives `rewrap`: the engine
   * rewraps an exchange before each step (to update the operation
   * header), so an operation that calls `markDropped(exchange)` is
   * marking the rewrapped instance, but the engine's outer parameter
   * is the pre-rewrap original. Both share the same internals object
   * via {@link DefaultExchange.rewrap}'s `rewrapState`, so the flag is
   * visible from either reference.
   *
   * @internal
   */
  dropped?: boolean;
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
 * Mark an exchange as dropped. Idempotent. Used by filter, choice, halt,
 * and the synthetic parse step's drop branch.
 *
 * The drop flag lives on the exchange's internals object (which is shared
 * by reference across `rewrap`) rather than a per-instance WeakSet, so a
 * filter that marks the rewrapped exchange the engine handed it remains
 * visible to the engine's final `isDropped` check on the outer parameter:
 * both reference the same internals.
 *
 * @internal
 */
export function markDropped(exchange: Exchange): void {
  const internals =
    (exchange as Exchange & { [INTERNALS_KEY]?: ExchangeInternals })[
      INTERNALS_KEY
    ] ?? EXCHANGE_INTERNALS.get(exchange);
  if (internals) internals.dropped = true;
}

/**
 * Returns true if the exchange (or any rewrap of it sharing the same
 * internals) has been marked as dropped.
 *
 * @internal
 */
export function isDropped(exchange: Exchange): boolean {
  const internals =
    (exchange as Exchange & { [INTERNALS_KEY]?: ExchangeInternals })[
      INTERNALS_KEY
    ] ?? EXCHANGE_INTERNALS.get(exchange);
  return internals?.dropped === true;
}

/**
 * Record the timestamp at which the runtime engine first encountered an
 * exchange in the step loop. Stored on the exchange's internals so it
 * survives `rewrap` (which shares internals between prev and next) and so
 * aggregator code can read child start times without a side channel.
 *
 * @internal
 */
export function setStartedAt(exchange: Exchange, ts: number): void {
  const internals =
    (exchange as Exchange & { [INTERNALS_KEY]?: ExchangeInternals })[
      INTERNALS_KEY
    ] ?? EXCHANGE_INTERNALS.get(exchange);
  if (internals) internals.startedAt = ts;
}

/**
 * Read the recorded start timestamp for an exchange, if one was set.
 *
 * @internal
 */
export function getStartedAt(exchange: Exchange): number | undefined {
  const internals =
    (exchange as Exchange & { [INTERNALS_KEY]?: ExchangeInternals })[
      INTERNALS_KEY
    ] ?? EXCHANGE_INTERNALS.get(exchange);
  return internals?.startedAt;
}

/**
 * Internal options accepted by {@link DefaultExchange}'s constructor.
 * The constructor freezes whatever it produces; callers can supply either a
 * `Readonly<...>` headers object (e.g. from another exchange) or a plain
 * literal.
 *
 * @internal
 */
type DefaultExchangeOptions<T> = {
  id?: string;
  body?: T;
  headers?: ExchangeHeaders;
  principal?: Principal | undefined;
};

/**
 * Internal payload used by {@link DefaultExchange.rewrap} to thread state
 * from the previous exchange into the new instance without going through
 * the public constructor's default-injection / fresh-logger paths.
 *
 * - `internals` is shared by reference so any post-construction write
 *   (route binding, child startedAt, parse hooks) is visible on every
 *   rewrap of the same logical exchange.
 * - `logger` is reused because its child bindings (contextId, route,
 *   correlationId, exchangeId) are unchanged across `rewrap` (rewrap
 *   preserves `id`).
 *
 * @internal
 */
type RewrapState = {
  readonly internals: ExchangeInternals;
  readonly logger: ReturnType<typeof logger.child>;
};

/**
 * Default implementation of the Exchange interface.
 *
 * Provides standard exchange functionality with automatic
 * ID generation and header initialization. Instances are immutable: the
 * constructor freezes the wrapper, headers, and principal. Body is left
 * unfrozen so user payloads of any shape can flow through; the framework
 * does not mutate it.
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
  readonly body: T;

  /** Authenticated principal, when one has been resolved. */
  readonly principal?: Principal | undefined;

  /** Logger for this exchange (pino child logger) */
  public readonly logger: ReturnType<typeof logger.child>;

  /**
   * Create a new exchange.
   *
   * @param context The CraftContext this exchange belongs to
   * @param options Optional configuration for the exchange
   * @param rewrapState Internal: when {@link DefaultExchange.rewrap} is
   *   building a derived instance, it threads the previous exchange's
   *   internals and logger through this parameter so they are genuinely
   *   shared (not just copied) and the constructor skips default
   *   `randomUUID()` / `logger.child(...)` work that the rewrap path
   *   would immediately overwrite. Not for direct adapter use.
   */
  constructor(
    context: CraftContext,
    options?: DefaultExchangeOptions<T>,
    rewrapState?: RewrapState,
  ) {
    this.id = options?.id || randomUUID();
    // Skip the default `randomUUID()` calls for ROUTE_ID / CORRELATION_ID
    // when the caller already supplies headers that include the standard
    // keys. The rewrap path always does (it spreads `prev.headers`), and
    // so do `buildExchange` / `split` (they set `routecraft.route`
    // explicitly). The legacy code path generated two UUIDs per
    // construction unconditionally and let the spread overwrite them,
    // which on a 5-step pipeline meant ~10 wasted crypto calls per
    // exchange.
    const supplied = options?.headers;
    this.headers =
      supplied && HeadersKeys.ROUTE_ID in supplied
        ? Object.freeze({ ...supplied })
        : Object.freeze({
            [HeadersKeys.ROUTE_ID]: randomUUID(),
            [HeadersKeys.OPERATION]: OperationType.FROM,
            [HeadersKeys.CORRELATION_ID]: randomUUID(),
            ...(supplied || {}),
          });
    // Honour an explicit `body: undefined` from the caller (e.g. a
    // transform that intentionally returns undefined for a missing JSON
    // path). Only fall back to `{}` when the caller did not pass a body
    // key at all.
    this.body = options && "body" in options ? (options.body as T) : ({} as T);
    if (options?.principal !== undefined) {
      // Object.freeze on a primitive is a no-op; on a Principal object it
      // makes claim mutation by adapters caught at runtime. We do not deep-
      // freeze the principal's internals (e.g. nested claims); shallow is
      // enough to stop direct rewrites like `exchange.principal.subject = ...`.
      this.principal = Object.freeze(options.principal);
    }

    // Store internals: symbol key (cross-instance) and WeakMap (same-instance compat).
    // Internals live BEFORE the wrapper is frozen because freeze prevents
    // adding new own properties; symbol-keyed `[INTERNALS_KEY]` must be
    // attached now. The internals OBJECT itself stays mutable (split.ts
    // sets `internals.route` after construction; that mutates the object,
    // not the exchange). When `rewrapState` is supplied, the previous
    // exchange's internals object is reused by reference so any post-
    // construction writes (route binding, child startedAt, parse hooks)
    // are visible on every rewrap of the same logical exchange.
    const internals: ExchangeInternals = rewrapState?.internals ?? { context };
    setInternals(this, INTERNALS_KEY, internals);
    EXCHANGE_INTERNALS.set(this, internals);
    setBrand(this, BRAND.Exchange);
    // Reuse `prev`'s logger when rewrapping; the child bindings
    // (contextId, route, correlationId, exchangeId) are unchanged because
    // rewrap preserves id, so the logger stays correctly scoped.
    this.logger = rewrapState?.logger ?? logger.child(childBindings(this));

    // Freeze the wrapper itself last so all properties (including the
    // symbol-keyed internals slot and the brand) are sealed against
    // reassignment. Mutating user code via `as any` casts now produces a
    // TypeError in strict mode, which the package runs in.
    Object.freeze(this);
  }

  /**
   * Construct a new {@link DefaultExchange} that combines internals from a
   * previous exchange (context, route binding, parse hooks) with field
   * overrides from a partial. Used by the engine to normalise plain
   * objects user code returns from `.process()` (or any `with*`-style
   * spread) back into proper instances without losing the framework's
   * back-channel state.
   *
   * - `id` defaults to `prev.id` (preserves identity through pipeline steps).
   * - `headers` defaults to `prev.headers` (frozen reference is safe to share).
   * - `body` defaults to `prev.body`.
   * - `principal` follows `?? prev.principal` semantics so a returned
   *   exchange that omits the principal inherits the parent's. Pass an
   *   explicit `Principal` to set; passing `undefined` does NOT clear.
   *
   * @internal
   */
  static rewrap<T>(
    prev: Exchange,
    partial: {
      readonly id?: string;
      readonly body?: T;
      readonly headers?: ExchangeHeaders;
      readonly principal?: Principal;
    } = {},
  ): DefaultExchange<T> {
    const prevInternals =
      (prev as Exchange & { [INTERNALS_KEY]?: ExchangeInternals })[
        INTERNALS_KEY
      ] ?? EXCHANGE_INTERNALS.get(prev);
    const context = prevInternals?.context;
    if (!context) {
      throw new Error(
        "DefaultExchange.rewrap: previous exchange has no context binding; " +
          "cannot construct a derived exchange. This usually means an " +
          "adapter constructed an Exchange-shaped plain object outside the " +
          "framework. Use `new DefaultExchange(context, { ... })` instead.",
      );
    }

    // For body, use `'body' in partial` so an explicit `body: undefined`
    // (e.g. `transform(() => undefined)` or `json({ path: missingKey })`)
    // sets the new body to undefined rather than inheriting prev's. Headers
    // are never undefined in the type system, and principal uses `??` to
    // preserve `?? prev.principal` inheritance semantics.
    //
    // Internals are shared by reference (not copied) via `rewrapState` so a
    // post-construction write on either prev or next is visible on the
    // other. The logger is reused for the same reason: bindings derive
    // from id/contextId/route/correlationId, all of which `rewrap`
    // preserves.
    return new DefaultExchange<T>(
      context,
      {
        id: partial.id ?? prev.id,
        headers: partial.headers ?? prev.headers,
        body: ("body" in partial ? partial.body : prev.body) as T,
        principal: partial.principal ?? prev.principal,
      },
      { internals: prevInternals, logger: prev.logger },
    );
  }
}
