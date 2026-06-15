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
  /** Fan the exchange out to multiple independent paths in parallel */
  MULTICAST = "multicast",
  /** Rate limit an operation, pacing exchanges that exceed the rate */
  THROTTLE = "throttle",
  /** Fast-fail an operation while a downstream is known to be failing */
  CIRCUIT_BREAKER = "circuit-breaker",
  /** Pass every Nth exchange (or the first per time window), dropping the rest */
  SAMPLE = "sample",
  /** Drop exchanges whose derived key has already been seen */
  DEDUPE = "dedupe",
  /** Short-circuit the pipeline: drop the exchange without further steps */
  HALT = "halt",
}

/**
 * Framework-owned header keys present on every exchange.
 *
 * The whole `routecraft.*` header namespace is RESERVED: the framework and
 * its adapters own every key under it. Adapter-specific keys live in
 * per-adapter key objects next to their adapters (e.g. `MailHeaders.UID`,
 * `CronHeaders.EXPRESSION`); each adapter merges its keys into
 * {@link RoutecraftHeaders} via declaration merging so they stay typed on
 * `exchange.headers`. User-defined headers must use their own namespace
 * (e.g. `x-...` or `myapp.*`).
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
  /**
   * Authenticated principal resolved from the request, when available.
   * Carries the structured `Principal` object; the `ex.principal` getter
   * is sugar over `ex.headers[HeadersKeys.AUTH_PRINCIPAL]`.
   */
  AUTH_PRINCIPAL: "routecraft.auth.principal",
} as const satisfies Record<string, string>;

/**
 * Typed map of well-known headers on an exchange. The core interface
 * declares only the framework-owned keys; adapters and ecosystem packages
 * merge their own `routecraft.<adapter>.*` keys in via declaration merging,
 * next to the adapter that owns them:
 *
 * ```ts
 * declare module "@routecraft/routecraft" {
 *   interface RoutecraftHeaders {
 *     "routecraft.myadapter.thing"?: string;
 *   }
 * }
 * ```
 *
 * The `routecraft.*` namespace is reserved for the framework and adapters;
 * see {@link HeadersKeys}.
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
}

/**
 * Allowed types for a single header value at the **bag** level.
 *
 * `unknown` lets cross-cutting concerns (auth principal, future tracing
 * spans, tenancy contexts) live in `headers` as a single typed slot rather
 * than being spread across many flat keys. Per-key types are narrowed by
 * {@link RoutecraftHeaders} (which adapters extend via declaration
 * merging); this bag-level type is just the catch-all for unregistered
 * keys.
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
 */
export type HeaderLiteral =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly string[]
  | Readonly<Record<string, unknown>>;

/**
 * Complete set of headers for an exchange. Read-only by contract: produce
 * derived headers via spread (`{ ...exchange.headers, key: value }`) and the
 * framework re-wraps the resulting exchange when the operation hands it back.
 *
 * Includes standard Routecraft headers, adapter-declared headers (merged
 * into {@link RoutecraftHeaders}), and custom headers.
 */
export type ExchangeHeaders = Readonly<
  Partial<RoutecraftHeaders> & Record<string, HeaderValue>
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
   * Route-scope cache key captured by the `cache-check` filter and
   * read back by the `cache-store` filter at the tail of the chain.
   * Lives on internals so the filters can be constructed once at
   * builder time (rather than per-`runPipeline` closures); each exchange
   * carries its own key via this slot. Unset when the route has no
   * `.cache()` configured. See `.standards/pre-from-filter-chain.md`.
   *
   * @internal
   */
  cacheKey?: string;
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
   * Set when an exchange is dropped (filter, choice halt / unmatched,
   * parse drop, input-validation drop, `recovery.drop()` directives; see
   * {@link emitExchangeDropped}). The runtime engine reads this
   * after `runPipeline` completes to skip `exchange:completed` emission.
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
 * Bind a route onto an exchange's internals. Symbol-key first (cross-instance
 * safe), WeakMap fallback -- the symmetric write half of {@link
 * getExchangeRoute}. Used wherever an exchange is constructed outside the
 * normal source path and must be made executor-ready (split children,
 * {@link cloneExchange}). The internals object is mutable post-construction
 * (the wrapper is frozen, the internals are not), so this is safe after the
 * exchange has been created.
 *
 * @internal
 */
export function setExchangeRoute(exchange: Exchange, route: Route): void {
  const internals =
    (exchange as Exchange & { [INTERNALS_KEY]?: ExchangeInternals })[
      INTERNALS_KEY
    ] ?? EXCHANGE_INTERNALS.get(exchange);
  if (internals) internals.route = route;
}

/**
 * Deep-clone an exchange for fan-out operations (the `tap` snapshot and
 * `multicast` paths). ONLY the body is deep-copied (`structuredClone`), so a
 * clone-side body mutation can never race the original. Headers are spread
 * SHALLOWLY: framework headers are immutable and safe to share by reference,
 * but object-valued user headers (e.g. `.header("x", { ... })`) remain shared
 * between the clone and the source -- mutating a nested header field is an
 * anti-pattern that is NOT isolated. The clone gets a fresh `routecraft.id`
 * (so logs and identity-aware tooling distinguish it) and preserves the
 * correlation id so it stays traceable to the same logical request.
 *
 * When `route` is supplied it is bound onto the clone's internals so the
 * clone can run through the pipeline executor (multicast paths need this). It
 * is left unset by default so a detached snapshot (tap) stays route-less and
 * route-reading adapters see no binding, matching tap's isolation contract.
 *
 * @internal
 */
export function cloneExchange<T>(
  exchange: Exchange<T>,
  context: CraftContext,
  route?: Route,
): Exchange<T> {
  const clone = new DefaultExchange<T>(context, {
    body: structuredClone(exchange.body),
    headers: {
      ...exchange.headers,
      [HeadersKeys.ID]: randomUUID(),
    },
  });
  if (route) setExchangeRoute(clone, route);
  return clone;
}

/**
 * Mark an exchange as dropped. Idempotent. Drop sites that also emit
 * `route:exchange:dropped` go through {@link emitExchangeDropped}, which
 * wraps this; call this directly only when there is no emission to pair
 * with (e.g. the cache wrapper's loader-drop path, or marking ahead of an
 * earlier event that carries the exchange).
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
 * Drop an exchange: mark it dropped, then emit `route:exchange:dropped`.
 *
 * This is the single sanctioned way to drop an exchange from a step or
 * pipeline site. The mark MUST precede the emission so a subscriber that
 * calls `isDropped(event.details.exchange)` observes the correct state;
 * the runtime engine reads the flag after `runPipeline` to skip
 * `exchange:completed` (see `pipeline/executor.ts`). The mark is
 * unconditional ({@link markDropped} is idempotent); the emission is
 * skipped when no context is bound, which keeps the drop flag correct
 * for synthetic exchanges in unit tests.
 *
 * Sites that emit additional events before the drop (`step:completed`,
 * `step:failed`, `operation:choice:unmatched`, error-handler events)
 * keep those emissions local and call this helper last, so
 * `route:exchange:dropped` stays the final event for the exchange.
 *
 * @internal
 */
export function emitExchangeDropped(
  context: CraftContext | undefined,
  details: {
    routeId: string;
    correlationId: string;
    reason: string;
    exchange: Exchange;
  },
): void {
  const { routeId, correlationId, reason, exchange } = details;
  markDropped(exchange);
  context?.emit("route:exchange:dropped", {
    routeId,
    exchangeId: exchange.id,
    correlationId,
    reason,
    exchange,
  });
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
 * Module-private hand-off slot for the rewrap fast path. `rewrap` writes
 * the previous exchange's state here immediately before calling the
 * constructor, which consumes (and clears) it as its first action; the
 * construction is synchronous, so nothing can interleave. Threading the
 * state through a slot instead of a constructor parameter keeps the
 * exported constructor surface at `(context, options?)`: no internal type
 * appears in the published declarations and external code has no way to
 * supply rewrap state.
 */
let pendingRewrap: RewrapState | undefined;

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
   */
  constructor(context: CraftContext, options?: DefaultExchangeOptions<T>) {
    // Consume the rewrap hand-off slot first so it can never leak into a
    // later construction (including when this constructor throws). When
    // {@link DefaultExchange.rewrap} is building a derived instance, the
    // slot threads the previous exchange's internals and logger through so
    // they are genuinely shared (not just copied) and the constructor
    // skips `logger.child(...)` work the rewrap path would otherwise
    // repeat. The slot is module-private, so this path is unreachable
    // from outside the framework.
    const rewrapState = pendingRewrap;
    pendingRewrap = undefined;
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
    pendingRewrap = {
      internals: prevInternals,
      logger: prev.logger,
    };
    return new DefaultExchange<T>(context, {
      headers: newHeaders,
      body: ("body" in partial ? partial.body : prev.body) as T,
    });
  }
}
