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
 *
 * @experimental
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
 *
 * @beta
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HeaderKeysRegistry {}

/**
 * Standard header keys used in exchanges.
 * These keys provide metadata and context for processing exchanges.
 *
 * Plugins can register additional keys by augmenting the
 * {@link HeaderKeysRegistry} interface.
 *
 * @beta
 */
export const HeadersKeys = {
  /** Unique identifier for this exchange. Stored in headers so it survives halt/continue alongside body. */
  ID: "routecraft.id",
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

  /**
   * Authenticated principal resolved from the request, when available.
   * Carries the structured `Principal` object; the `ex.principal` getter
   * is sugar over `ex.headers[HeadersKeys.AUTH_PRINCIPAL]`.
   */
  AUTH_PRINCIPAL: "routecraft.auth.principal",
} as const satisfies Record<string, string>;

/**
 * Standard headers used by the Routecraft framework.
 * These headers provide critical metadata for processing exchanges.
 *
 * Plugins can extend this via module augmentation alongside
 * {@link HeaderKeysRegistry} to add typed headers.
 *
 * @beta
 */
export interface RoutecraftHeaders {
  /**
   * Unique identifier for this exchange.
   *
   * Stored in headers (not as a separate field) so it travels with the
   * exchange's serializable state. This is the single source of truth for
   * exchange identity; the `ex.id` getter reads from this key.
   */
  "routecraft.id": string;

  /** The current operation being performed (OperationType or DSL label) */
  "routecraft.operation": OperationType | string;

  /** The ID of the route processing this exchange */
  "routecraft.route": string;

  /** Unique identifier for correlating related exchanges */
  "routecraft.correlation_id": string;

  /** Hierarchy path for split operations */
  "routecraft.split_hierarchy"?: readonly string[];

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
 * Allowed types for a single header value at the **bag** level.
 *
 * `unknown` lets cross-cutting concerns (auth principal, future tracing
 * spans, tenancy contexts) live in `headers` as a single typed slot rather
 * than being spread across many flat keys. Per-key types are narrowed by
 * {@link RoutecraftHeaders} and by the {@link HeaderKeysRegistry}
 * declaration-merging mechanism; this bag-level type is just the catch-all
 * for unregistered keys.
 *
 * For API surfaces that accept a static header value (e.g. `.header("k",
 * v)`), prefer {@link HeaderLiteral} which excludes function types so user
 * lambdas get correct inference in the value-or-function overload.
 *
 * Array values declared on registered keys are typed `readonly string[]` so
 * they cannot be mutated via `push` / `splice` / index assignment through
 * the (already `Readonly<>`) `ExchangeHeaders` map. The contract is
 * type-level; the constructor freezes array values defensively so a caller
 * who casts away the readonly cannot mutate a shared reference.
 *
 * @beta
 */
export type HeaderValue = unknown;

/**
 * Allowed types for a header value when supplied as a literal at an API
 * boundary that also accepts a callback (e.g. `.header("k", v)` /
 * `.header("k", ex => ...)`). Excludes function types so the callback arm
 * of the union infers parameters correctly.
 *
 * Includes the original primitive types for source-compat plus
 * `Readonly<Record<string, unknown>>` so structured values (Principal,
 * future Span, etc.) can be assigned directly when they aren't mediated by
 * a callback.
 *
 * @beta
 */
export type HeaderLiteral =
  | string
  | number
  | boolean
  | undefined
  | readonly string[]
  | Readonly<Record<string, unknown>>;

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
 *
 * @beta
 */
export type ExchangeHeaders = Readonly<
  Partial<RoutecraftHeaders> & RegistryHeaders & Record<string, HeaderValue>
>;

/**
 * Represents a message being processed through a route.
 *
 * An exchange has two kinds of state:
 *
 * 1. **Stored fields** (`body`, `headers`) carry the data and metadata that
 *    must survive halt/continue. Persistence serializes exactly these two
 *    slots; rehydration constructs a new instance around them.
 * 2. **Derived accessors** (`id`, `principal`, `logger`) read from
 *    `headers` (or runtime services) and look like properties at the call
 *    site. They are not stored separately. `id` reads
 *    `headers["routecraft.id"]`; `principal` reads
 *    `headers["routecraft.auth.principal"]`; `logger` builds a child logger
 *    lazily from the framework's logger and the exchange's id.
 *
 * Cross-cutting concerns (auth, tracing, tenancy) all live as keys in
 * `headers` rather than as top-level fields. This keeps the serialization
 * surface small and avoids a "special field" precedent for every new
 * concern.
 *
 * Exchanges are immutable. Operations that change body or headers must
 * produce a new exchange (typically via spread) and return it; the
 * framework re-wraps the result via {@link DefaultExchange.rewrap} so it
 * preserves internal bindings (context, route). Body is not deep-frozen so
 * adapter authors can attach arbitrary user payloads, but the framework
 * will not mutate it and authors should treat it the same way.
 *
 * @template T The type of data in the body
 * @experimental
 */
export type Exchange<T = unknown> = {
  /**
   * Unique identifier for this exchange.
   *
   * Reads from `headers["routecraft.id"]`. Stable across `rewrap`s so
   * pipeline steps see the same id throughout a route.
   */
  readonly id: string;

  /** Headers containing metadata, including cross-cutting concerns like the authenticated principal. */
  readonly headers: ExchangeHeaders;

  /** The data being processed */
  readonly body: T;

  /**
   * Authenticated principal for this exchange, when one has been resolved.
   *
   * Sugar over `headers["routecraft.auth.principal"]`. Set automatically by
   * source adapters that perform authentication (e.g. the MCP server when
   * `auth:` is configured) by writing the principal into headers. Routes
   * may also assign a custom principal in `.process()` by spreading new
   * headers with this key.
   *
   * Propagates naturally because it lives in `headers`: any operation that
   * spreads `prev.headers` keeps the principal sticky-set automatically,
   * with no special-case plumbing.
   *
   * @experimental
   */
  readonly principal?: Principal | undefined;

  /**
   * Logger for this exchange (pino child logger).
   *
   * Built lazily from the framework's base logger and the exchange's id /
   * route / correlation. Not stored as serializable state; rehydrated
   * exchanges build a fresh child logger on first access.
   */
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
 * @experimental
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
 * @experimental
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
 * `id` and `principal` are NOT options here: they live inside `headers`
 * (`headers["routecraft.id"]` and `headers["routecraft.auth.principal"]`).
 * Callers that want to control them set the corresponding header keys when
 * building `headers`.
 *
 * @internal
 */
type DefaultExchangeOptions<T> = {
  body?: T;
  headers?: ExchangeHeaders;
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
 *   preserves `id`). Pre-populating the lazy `#logger` slot avoids
 *   rebuilding the same child on every rewrap of a long pipeline.
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
 * The implementation stores exactly two fields, `body` and `headers`.
 * Everything else surfaced on the public `Exchange<T>` API (`id`,
 * `principal`, `logger`) is exposed through getters that derive from
 * `headers` plus runtime services. This keeps the serialization surface
 * for halt/continue narrow (just `{ body, headers }`) and removes the
 * "special field" precedent for cross-cutting concerns.
 *
 * Instances are immutable: the constructor freezes the wrapper and headers
 * (and any non-primitive header values, defensively). Body is left
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
 * console.log(exchange.id);        // Unique UUID (read from headers["routecraft.id"])
 * console.log(exchange.body);      // "Hello, World!"
 * console.log(exchange.headers);   // Headers object with standard fields
 * ```
 *
 * @experimental
 */
export class DefaultExchange<T = unknown> implements Exchange<T> {
  /** Headers containing metadata, including the exchange id and (when set) the authenticated principal. */
  readonly headers: ExchangeHeaders;

  /** The data being processed */
  readonly body: T;

  /**
   * Lazily-built pino child logger. Filled on first access by the `logger`
   * getter, or pre-populated by `rewrap` so a long pipeline reuses the
   * parent exchange's child instead of rebuilding it on every step.
   *
   * Private fields are stored in a hidden internal slot, not as own
   * properties, so writes to `#logger` are unaffected by `Object.freeze(this)`.
   */
  #logger: ReturnType<typeof logger.child> | undefined;

  /**
   * Create a new exchange.
   *
   * @param context The CraftContext this exchange belongs to
   * @param options Optional configuration for the exchange. Set the exchange
   *   id by including `headers["routecraft.id"]`; set the principal by
   *   including `headers["routecraft.auth.principal"]`. Both default to
   *   sensible runtime values when omitted (id: `randomUUID()`).
   * @param rewrapState Internal: when {@link DefaultExchange.rewrap} is
   *   building a derived instance, it threads the previous exchange's
   *   internals and logger through this parameter so they are genuinely
   *   shared (not just copied) and the constructor skips
   *   `logger.child(...)` work that the rewrap path would otherwise repeat.
   *   Not for direct adapter use.
   */
  constructor(
    context: CraftContext,
    options?: DefaultExchangeOptions<T>,
    rewrapState?: RewrapState,
  ) {
    // Per-key gating preserves required defaults (`ID`, `OPERATION`,
    // `ROUTE_ID`, `CORRELATION_ID`) when a caller supplies only some of
    // them, instead of an all-or-nothing fast path that would silently
    // drop the others. The rewrap path supplies all four via the spread
    // of `prev.headers`, so the `??` branches are no-ops in the hot path
    // and the per-construction `randomUUID()` cost is paid only at the
    // route boundary.
    //
    // The supplied headers are spread FIRST so that the explicit
    // required-key slots that follow override an `undefined` value the
    // caller may have included (e.g. `{ ROUTE_ID: undefined }`). If the
    // spread came last, an explicit `undefined` would clobber the
    // just-computed default and leave required headers missing.
    const supplied = options?.headers;
    const merged: Record<string, HeaderValue> = {
      ...(supplied || {}),
      [HeadersKeys.ID]: supplied?.[HeadersKeys.ID] ?? randomUUID(),
      [HeadersKeys.ROUTE_ID]: supplied?.[HeadersKeys.ROUTE_ID] ?? randomUUID(),
      [HeadersKeys.OPERATION]:
        supplied?.[HeadersKeys.OPERATION] ?? OperationType.FROM,
      [HeadersKeys.CORRELATION_ID]:
        supplied?.[HeadersKeys.CORRELATION_ID] ?? randomUUID(),
    };
    // Defensive freeze on values that callers might mutate by reference:
    //
    // - Arrays: type-level `readonly` on `HeaderValue` array variants
    //   prevents mutation through `exchange.headers` in TypeScript code,
    //   but a caller who casts away the readonly could still
    //   `arr.push(...)` into a shared array reference. Clone-and-freeze
    //   each unfrozen array so the runtime guarantee matches the type
    //   contract.
    // - Principal: a structured header value. Shallow-freezing the wrapper
    //   makes claim mutation by adapters caught at runtime
    //   (`exchange.principal.subject = ...` throws). Nested claims are
    //   not deep-frozen.
    //
    // We don't deep-clone or freeze arbitrary objects; those are caller
    // payloads and the framework treats them as opaque, the same way
    // `body` is left unfrozen.
    for (const key of Object.keys(merged)) {
      const value = merged[key];
      if (Array.isArray(value) && !Object.isFrozen(value)) {
        merged[key] = Object.freeze([...value]);
      }
    }
    // This block is an immutability defence only; it is NOT load-bearing for
    // authenticity. Trust is conferred solely by membership in the private
    // WeakSet in `auth/authentic.ts` (added by `markAuthentic`), which a clone
    // here would not carry. Authentic principals always arrive already frozen
    // (markAuthentic freezes), so this clone-and-freeze fires only for a
    // self-asserted plain object, which `authorize()` rejects regardless.
    const principal = merged[HeadersKeys.AUTH_PRINCIPAL];
    if (
      principal !== undefined &&
      typeof principal === "object" &&
      principal !== null &&
      !Object.isFrozen(principal)
    ) {
      merged[HeadersKeys.AUTH_PRINCIPAL] = Object.freeze({
        ...(principal as Principal),
      });
    }
    this.headers = Object.freeze(merged);
    // Honour an explicit `body: undefined` from the caller (e.g. a
    // transform that intentionally returns undefined for a missing JSON
    // path). Only fall back to `{}` when the caller did not pass a body
    // key at all.
    this.body = options && "body" in options ? (options.body as T) : ({} as T);

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
    // Pre-populate the lazy logger slot when rewrapping. The child
    // bindings (contextId, route, correlationId, exchangeId) are
    // unchanged because rewrap preserves id, so the parent's logger
    // stays correctly scoped. Fresh exchanges leave `#logger` undefined
    // so the first read of `.logger` builds the child on demand.
    if (rewrapState?.logger) {
      this.#logger = rewrapState.logger;
    }

    // Freeze the wrapper itself last so own properties (including the
    // symbol-keyed internals slot and the brand) are sealed against
    // reassignment. Mutating user code via `as any` casts now produces a
    // TypeError in strict mode, which the package runs in. Private fields
    // (`#logger`) live in a hidden internal slot and are unaffected by
    // freeze, so the lazy-build path keeps working post-freeze.
    Object.freeze(this);
  }

  /**
   * Unique identifier for this exchange. Reads from
   * `headers["routecraft.id"]` so the id travels with the serializable
   * state and survives halt/continue.
   */
  get id(): string {
    return this.headers[HeadersKeys.ID] as string;
  }

  /**
   * Authenticated principal, when one has been resolved. Sugar over
   * `headers["routecraft.auth.principal"]`.
   */
  get principal(): Principal | undefined {
    return this.headers[HeadersKeys.AUTH_PRINCIPAL] as Principal | undefined;
  }

  /**
   * Pino child logger scoped to this exchange. Built lazily from the
   * framework's base logger; rebuilt on a rehydrated exchange because the
   * logger is not part of the serializable state.
   */
  get logger(): ReturnType<typeof logger.child> {
    if (this.#logger === undefined) {
      this.#logger = logger.child(childBindings(this));
    }
    return this.#logger;
  }

  /**
   * Construct a new {@link DefaultExchange} that combines internals from a
   * previous exchange (context, route binding, parse hooks) with field
   * overrides from a partial. Used by the engine to normalise plain
   * objects user code returns from `.process()` (or any `with*`-style
   * spread) back into proper instances without losing the framework's
   * back-channel state.
   *
   * - `headers` defaults to `prev.headers`. Identity (`routecraft.id`) is
   *   forced to `prev.id` so it survives a caller-supplied headers object
   *   that came from a different exchange. Cross-cutting concerns
   *   (`routecraft.auth.principal`, future tracing/tenancy keys) flow
   *   through naturally because they live in the same headers bag.
   * - `body` defaults to `prev.body`.
   *
   * Identity-changing operations (split, aggregate restoring a parent)
   * construct a new `DefaultExchange` directly with fresh headers rather
   * than calling `rewrap`.
   *
   * @internal
   */
  static rewrap<T>(
    prev: Exchange,
    partial: {
      readonly body?: T;
      readonly headers?: ExchangeHeaders;
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

    // Force prev's id into the new headers so a caller-supplied `headers`
    // object that came from a foreign exchange (e.g. user code returning
    // `{ ...someOtherExchange, body: x }` from `.process()`) does not
    // silently change the exchange identity mid-route. Identity is owned
    // by the framework and is preserved across rewraps. Identity-changing
    // operations (split, aggregate-restore-parent) construct a new
    // `DefaultExchange` directly rather than going through `rewrap`.
    //
    // For body, use `'body' in partial` so an explicit `body: undefined`
    // (e.g. `transform(() => undefined)` or `json({ path: missingKey })`)
    // sets the new body to undefined rather than inheriting prev's.
    //
    // Internals are shared by reference (not copied) via `rewrapState` so a
    // post-construction write on either prev or next is visible on the
    // other. The logger is reused for the same reason: bindings derive
    // from id/contextId/route/correlationId, all of which `rewrap`
    // preserves.
    const baseHeaders = partial.headers ?? prev.headers;
    const newHeaders =
      baseHeaders[HeadersKeys.ID] === prev.id
        ? baseHeaders
        : { ...baseHeaders, [HeadersKeys.ID]: prev.id };
    return new DefaultExchange<T>(
      context,
      {
        headers: newHeaders,
        body: ("body" in partial ? partial.body : prev.body) as T,
      },
      { internals: prevInternals, logger: prev.logger },
    );
  }
}
