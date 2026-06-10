import { type Exchange, type ExchangeHeaders } from "./exchange.ts";
import { type OperationType } from "./exchange.ts";
import { type CraftContext } from "./context.ts";
import { type RouteDefinition } from "./route.ts";
import { type Route } from "./route.ts";
import { type OnParseError } from "./adapters/shared/parse.ts";

/**
 * Base interface for all adapters (sources, destinations, transformers, filters, etc.).
 * Adapters can expose an optional `adapterId` string for logging (e.g. "routecraft.adapter.log").
 */
export interface Adapter {
  /**
   * Dotted identifier used for log and trace labels, by convention
   * "<vendor>.adapter.<name>" (e.g. "routecraft.adapter.mail"). The last
   * segment is shown in step events and logs. Optional so inline adapter
   * objects (e.g. `{ aggregate: fn }`) stay ergonomic; framework-shipped
   * adapters always set it.
   */
  adapterId?: string;
}

/**
 * Returns a short label for logging which adapter is used.
 * Uses adapterId's last segment (e.g. "routecraft.adapter.llm" → "llm"), constructor name, or "inline" for plain objects.
 *
 * @param adapter - Adapter instance (or undefined)
 * @returns Label string or undefined
 */
export function getAdapterLabel(
  adapter: Adapter | undefined,
): string | undefined {
  if (!adapter) return undefined;
  if (adapter.adapterId) return adapter.adapterId.split(".").pop();
  const name = (adapter as { constructor?: { name?: string } }).constructor
    ?.name;
  return name === "Object" ? "inline" : name;
}

export interface Step<T extends Adapter> {
  operation: OperationType;
  adapter: T;

  /**
   * Display name shown in traces, logs, and step events instead of the
   * raw OperationType. Set automatically by registerDsl for sugar methods
   * (e.g., "log" instead of "tap", "schema" instead of "validate").
   * When absent, the operation field is used.
   */
  label?: string;

  /**
   * When true, runSteps will not emit generic step:started/step:completed
   * events for this step. The step is responsible for emitting its own
   * lifecycle events with the correct exchange identity.
   */
  skipStepEvents?: boolean;

  /**
   * Optional metadata populated by the adapter during execution.
   * Used for observability, metrics, and cost tracking.
   * Guidelines: small values only (IDs, names, counts, codes), no large bodies.
   */
  metadata?: Record<string, unknown>;

  /**
   * Execute this step and report what happened. The executor owns all
   * scheduling: steps no longer see the work queue or the remaining
   * pipeline, they describe an outcome and the engine routes it.
   *
   * The exchange is typed as Exchange at runtime (body is unknown);
   * the builder chain preserves body types for the next step, but custom
   * steps receive an untyped exchange. Narrow or assert body type if needed.
   */
  execute(exchange: Exchange, ctx: StepContext): Promise<StepOutcome>;
}

/**
 * What a step did with its exchange. Returned from {@link Step.execute};
 * the pipeline executor translates outcomes into scheduling:
 *
 * - `continue`: run the remaining steps against `exchange` (the common case;
 *   `exchange` is usually a rewrapped derivation of the input).
 * - `complete`: skip the remaining steps and complete the exchange
 *   successfully (route-scope cache hit).
 * - `drop`: halt the exchange. The step has already called `markDropped`
 *   and emitted its drop events (filter reject, choice unmatched,
 *   parse-drop); the executor schedules nothing.
 * - `branch`: run `steps` and then the remaining steps against `exchange`
 *   (choice routes into the matched branch).
 * - `fanOut`: schedule each child exchange independently through the
 *   remaining steps (split).
 */
export type StepOutcome =
  | { kind: "continue"; exchange: Exchange }
  | { kind: "complete"; exchange: Exchange }
  | { kind: "drop" }
  | { kind: "branch"; exchange: Exchange; steps: Step<Adapter>[] }
  | { kind: "fanOut"; exchanges: Exchange[] };

/**
 * Narrow executor capability handed to {@link Step.execute}.
 *
 * `takePending` atomically removes and returns pending sibling exchanges
 * matching the predicate; it exists for join-style steps (aggregate) that
 * consume their split siblings. The queue itself is never exposed, so
 * steps cannot reorder, duplicate, or corrupt scheduling.
 */
export interface StepContext {
  takePending(predicate: (exchange: Exchange) => boolean): Exchange[];
}

// MessageChannel lives with channel adapter now

export type ConsumerType<T extends Consumer, O = unknown> = new (
  context: CraftContext,
  definition: RouteDefinition,
  channel: unknown,
  options: O,
) => T;

/**
 * Internal envelope flowing from a source adapter to its consumer through the
 * route's processing queue.
 *
 * @property message - Raw payload as the adapter handed it to `handler(...)`.
 *   When `parse` is set this is typically the unparsed bytes/string; when
 *   `parse` is unset this is the already-parsed value used directly as the
 *   exchange body.
 * @property headers - Optional exchange headers attached by the adapter.
 * @property parse - Optional parser the runtime invokes as a synthetic first
 *   step before any user-defined steps run. When provided, the runtime
 *   builds a derived exchange via
 *   `DefaultExchange.rewrap(exchange, { body: await parse(exchange.body) })`
 *   inside the same try/catch that handles step errors, so a parse
 *   failure flows through the route's `errorHandler` and
 *   `exchange:failed` event path. See `adapters/shared/parse.ts` for
 *   the `OnParseError` semantics. If `parse` resolves to `undefined`
 *   the body is explicitly set to `undefined` (the rewrap respects an
 *   explicit `body: undefined`), not left as the previous value.
 * @property parseFailureMode - Decides how the synthetic parse step handles
 *   a thrown parse error. `"fail"` (default) and `"abort"` throw `RC5016`
 *   so `exchange:failed` fires; `"drop"` instead emits `exchange:dropped`
 *   with `reason: "parse-failed"`. Adapters set this from their
 *   `onParseError` option; the source loop additionally rethrows for
 *   `"abort"` so the source dies. See #187.
 *
 * parse-error-handling work in #187. Their shape may evolve.
 */
export type Message<T = unknown> = {
  /**
   * The payload. When `parse` is set this is the RAW pre-parse value
   * (e.g. a JSON line string), typed as `T` only after the synthetic
   * parse step runs; adapters narrow at the call site.
   */
  message: T;
  headers?: ExchangeHeaders;
  parse?: (raw: unknown) => unknown | Promise<unknown>;
  parseFailureMode?: OnParseError;
};

export interface Consumer<O = unknown> {
  context: CraftContext;
  channel: unknown; // will be narrowed by specific consumer types
  definition: RouteDefinition;
  options: O;
  /**
   * Register the route handler. At runtime, message and the returned exchange's body
   * are untyped (unknown). The builder chain is typed; narrow or assert in the handler
   * if you need to access body fields.
   *
   * The optional `parse` argument is forwarded by the consumer when the
   * source adapter attached one to the queued `Message`. The route
   * captures it on the exchange internals so `runSteps` can apply it as a
   * synthetic first pipeline step. Consumers that merge multiple messages
   * (e.g. batch) parse items eagerly during enqueue and pass a `parse`-less
   * call here.
   */
  register(
    handler: (
      message: unknown,
      headers?: ExchangeHeaders,
      parse?: (raw: unknown) => unknown | Promise<unknown>,
      parseFailureMode?: OnParseError,
    ) => Promise<Exchange>,
  ): void;
}

/**
 * Internal queue API for route source→consumer flow. Sources enqueue messages; the consumer handler is set by the route and receives messages. Used by DefaultRoute.
 *
 * @template T - Message type (typically Message with message + headers)
 */
export interface ProcessingQueue<T = unknown> {
  enqueue(message: T): Promise<Exchange>;
  setHandler(handler: (message: T) => Promise<Exchange>): Promise<void> | void;
  clear(): Promise<void> | void;
}

// Events API

/** Exchange snapshot attached to terminal exchange events. */
type ExchangeSnapshot = {
  id: string;
  headers: Record<string, unknown>;
  body: unknown;
};

/** Shared identity fields on per-exchange events. */
type ExchangeScoped = {
  routeId: string;
  exchangeId: string;
  correlationId: string;
};

/**
 * Every event the framework emits, mapped to its detail payload.
 *
 * Event names are a FIXED, finite set: identity (route id, plugin id,
 * step label) lives in the payload, not the name. Subscribe with exact
 * names and filter on payload fields (see {@link forRoute}), or use the
 * single catch-all `"*"` to observe everything (telemetry-style taps).
 *
 * Declared as an interface so ecosystem packages can add their own events
 * via declaration merging, mirroring `ErrorCodeRegistry` / `StoreRegistry`:
 *
 * ```typescript
 * declare module "@routecraft/routecraft" {
 *   interface EventDetailsMap {
 *     "myext:thing:happened": { routeId: string; thing: string };
 *   }
 * }
 * ```
 */
export interface EventDetailsMap {
  // -- Context lifecycle --
  "context:starting": Record<string, never>;
  "context:started": Record<string, never>;
  "context:stopping": { reason?: unknown };
  "context:stopped": Record<string, never>;
  "context:error": {
    error: unknown;
    route?: Route;
    exchange?: Exchange<unknown>;
  };

  // -- Auth --
  "auth:success": { subject: string; scheme: string; source: string };
  "auth:rejected": { reason: string; scheme: string; source: string };

  // -- Route lifecycle --
  "route:registered": { routeId: string; route: Route };
  "route:starting": { routeId: string; route: Route };
  "route:started": { routeId: string; route: Route };
  "route:stopping": {
    routeId: string;
    route: Route;
    reason?: unknown;
    exchange?: Exchange<unknown>;
  };
  "route:stopped": {
    routeId: string;
    route: Route;
    exchange?: Exchange<unknown>;
  };
  "route:error": {
    routeId: string;
    error: unknown;
    route?: Route;
    exchange?: Exchange<unknown>;
  };
  "route:error:caught": {
    routeId: string;
    error: unknown;
    route?: Route;
    exchange?: Exchange<unknown>;
  };

  // -- Exchange lifecycle --
  "route:exchange:started": ExchangeScoped;
  "route:exchange:completed": ExchangeScoped & {
    duration: number;
    exchange?: ExchangeSnapshot;
  };
  "route:exchange:failed": ExchangeScoped & {
    duration: number;
    error: unknown;
    exchange?: ExchangeSnapshot;
  };
  "route:exchange:dropped": ExchangeScoped & {
    reason: string;
    exchange?: ExchangeSnapshot;
  };
  "route:exchange:restored": ExchangeScoped & { source: string };

  // -- Step lifecycle --
  "route:step:started": ExchangeScoped & {
    operation: OperationType | string;
    adapter?: string;
  };
  "route:step:completed": ExchangeScoped & {
    operation: OperationType | string;
    adapter?: string;
    duration: number;
    metadata?: Record<string, unknown>;
  };
  "route:step:failed": ExchangeScoped & {
    operation: OperationType | string;
    adapter?: string;
    duration: number;
    error: string;
  };
  /** A step threw; `operation` is the step label (was `route:<id>:step:<label>:error`). */
  "route:step:error": {
    routeId: string;
    error: unknown;
    route?: Route;
    exchange?: Exchange<unknown>;
    operation: string;
  };
  "route:step:error:caught": {
    routeId: string;
    error: unknown;
    route?: Route;
    exchange?: Exchange<unknown>;
    operation: string;
  };

  // -- Batch --
  "route:batch:started": {
    routeId: string;
    batchSize: number;
    batchId: string;
  };
  "route:batch:flushed": {
    routeId: string;
    batchSize: number;
    batchId: string;
    waitTime: number;
    reason: "size" | "time";
  };
  "route:batch:stopped": { routeId: string; batchId: string };

  // -- Retry (reserved for the retry wrapper) --
  "route:retry:started": ExchangeScoped & { maxAttempts: number };
  "route:retry:attempt": ExchangeScoped & {
    attemptNumber: number;
    maxAttempts: number;
    backoffMs: number;
    lastError?: unknown;
  };
  "route:retry:stopped": ExchangeScoped & {
    attemptNumber: number;
    success: boolean;
  };

  // -- Error handler (route- and step-scope wrappers) --
  "route:error-handler:invoked": ExchangeScoped & {
    originalError: unknown;
    failedOperation: string;
    /**
     * `"route"` for the route-level (`.error()` before `.from()`)
     * catch-all handler; `"step"` for a wrapper-scope handler
     * attached to a single step (`.error()` after `.from()`).
     */
    scope?: "route" | "step";
    /** Step label when `scope === "step"`. */
    stepLabel?: string;
  };
  "route:error-handler:recovered": ExchangeScoped & {
    originalError: unknown;
    failedOperation: string;
    recoveryStrategy: string;
    scope?: "route" | "step";
    stepLabel?: string;
  };
  "route:error-handler:failed": ExchangeScoped & {
    originalError: unknown;
    failedOperation: string;
    recoveryStrategy?: string;
    scope?: "route" | "step";
    stepLabel?: string;
  };

  // -- Cache --
  "route:cache:hit": ExchangeScoped & {
    /** Label of the wrapped step, or `"route"` when `scope === "route"`. */
    stepLabel: string;
    scope: "route" | "step";
    key: string;
  };
  "route:cache:miss": ExchangeScoped & {
    stepLabel: string;
    scope: "route" | "step";
    key: string;
    /** True when the wrapped step dropped the exchange (filter/halt). */
    dropped?: boolean;
  };
  "route:cache:stored": ExchangeScoped & {
    stepLabel: string;
    scope: "route" | "step";
    key: string;
    /** TTL in ms when one was configured. */
    ttl?: number;
  };
  "route:cache:failed": ExchangeScoped & {
    stepLabel: string;
    scope: "route" | "step";
    /**
     * Where the failure occurred: `"key"` = key derivation threw,
     * `"get"` = provider read threw, `"inner"` = the wrapped step threw,
     * `"set"` = the provider write threw after the wrapped step succeeded.
     */
    phase: "key" | "get" | "inner" | "set";
    key?: string;
    error: string;
  };

  // -- Choice --
  "route:operation:choice:matched": ExchangeScoped & {
    branchIndex: number;
    branchLabel: "when" | "otherwise";
  };
  "route:operation:choice:unmatched": ExchangeScoped;

  // -- Agent (emitted by @routecraft/ai agent() destinations) --
  "route:agent:tool:invoked": ExchangeScoped & {
    toolCallId: string;
    toolName: string;
    input: unknown;
  };
  "route:agent:tool:result": ExchangeScoped & {
    toolCallId: string;
    toolName: string;
    output: unknown;
    duration: number;
  };
  "route:agent:tool:error": ExchangeScoped & {
    toolCallId: string;
    toolName: string;
    error: unknown;
    duration: number;
  };
  "route:agent:block:loaded": ExchangeScoped & {
    toolCallId: string;
    blockName: string;
    output: unknown;
    duration: number;
  };
  "route:agent:block:error": ExchangeScoped & {
    toolCallId: string;
    blockName: string;
    error: unknown;
    duration: number;
  };
  "route:agent:finished": ExchangeScoped & {
    finishReason: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  "route:agent:error": ExchangeScoped & { error: unknown };

  // -- HTTP plugin --
  "plugin:http:server:listening": { port: number; host: string };
  "plugin:http:server:closed": Record<string, never>;
  "plugin:http:request:completed": {
    method: string;
    path: string;
    status: number;
    durationMs: number;
    routeId?: string;
    principal?: { subject: string } | undefined;
  };

  // -- Plugin lifecycle --
  "plugin:registered": { pluginId: string; pluginIndex: number };
  "plugin:starting": { pluginId: string; pluginIndex: number };
  "plugin:started": { pluginId: string; pluginIndex: number };
  "plugin:stopping": { pluginId: string; pluginIndex: number };
  "plugin:stopped": { pluginId: string; pluginIndex: number };
}

/**
 * Union of all event names: the keys of {@link EventDetailsMap} plus the
 * catch-all `"*"` accepted by `on()` / `once()` (never emitted itself).
 */
export type EventName = keyof EventDetailsMap;

/** Detail payload for a given event name. */
export type EventDetailsMapping<K extends EventName = EventName> =
  EventDetailsMap[K];

export type EventPayload<K extends EventName> = {
  ts: string;
  contextId: string;
  details: EventDetailsMap[K];
  /** The exact event name that was emitted. Set by context.emit(). */
  _event: string;
};

export type EventHandler<K extends EventName> = (
  payload: EventPayload<K>,
) => void | Promise<void>;

/**
 * Wrap an event handler so it only fires for events whose payload carries
 * the given `routeId`. Identity lives in the payload (event names are a
 * fixed set), so per-route subscription is a filter:
 *
 * ```typescript
 * ctx.on("route:exchange:failed", forRoute("orders", ({ details }) => {
 *   console.error("orders failed:", details.error);
 * }));
 * ```
 */
export function forRoute<K extends EventName>(
  routeId: string,
  handler: EventHandler<K>,
): EventHandler<K> {
  return (payload) => {
    if ((payload.details as { routeId?: string }).routeId === routeId) {
      return handler(payload);
    }
    return undefined;
  };
}
