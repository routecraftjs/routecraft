import type { Exchange, ExchangeHeaders } from "./exchange.ts";
import type { OperationType } from "./exchange.ts";
import type { CraftContext } from "./context.ts";
import type { RouteDefinition } from "./route.ts";
import type { Route } from "./route.ts";
import type { OnParseError } from "./adapters/shared/parse.ts";
import type { SuspendRequest } from "./suspension/sites.ts";
import type { PrincipalRef } from "./suspension/types.ts";
import type { HealthChange } from "./plugins/ops/types.ts";

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

  /**
   * Observability hook for the FETCH slot: given the value the fetch
   * produced, return details to attach to the step's completion event
   * (`details.metadata`). Fires for `.enrich()` and for a fetch-only adapter
   * in `.to()`.
   *
   * Derive the result from the arguments, never from state written during the
   * call: one adapter instance serves every exchange on a route, so a field
   * set by one call is routinely read back by another.
   *
   * @param result - Value the fetch resolved to
   * @param exchange - Exchange the call ran against
   */
  getMetadata?(
    result: unknown,
    exchange?: Exchange<unknown>,
  ): StepOutcomeMetadata;

  /**
   * Observability hook for the SEND slot: given the receipt headers the send
   * recorded through {@link SendContext} (or `undefined` when it recorded
   * none), return details to attach to the step's completion event. Fires for
   * a send-resolved `.to()`.
   *
   * Named separately from {@link Adapter.getMetadata} so an adapter filling
   * both slots never has to sniff which contract it was handed. The same
   * no-instance-state rule applies.
   *
   * @param receipts - Receipt headers collected during the send
   * @param exchange - Exchange the call ran against
   */
  getSendMetadata?(
    receipts: unknown,
    exchange?: Exchange<unknown>,
  ): StepOutcomeMetadata;
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
   * When true, runPipeline will not emit generic step:started/step:completed
   * events for this step. The step is responsible for emitting its own
   * lifecycle events with the correct exchange identity.
   */
  skipStepEvents?: boolean;

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
 * Observability metadata a step may attach to its outcome (e.g. LLM token
 * usage, HTTP status codes). The executor copies it into the
 * `route:step:completed` event payload. Guidelines: small values only
 * (IDs, names, counts, codes), no large bodies. Outcome-scoped on purpose:
 * `Step` instances are shared across exchanges, so per-execution data must
 * never live on the step itself.
 */
export type StepOutcomeMetadata = Record<string, unknown>;

/**
 * Read {@link StepOutcomeMetadata} from an adapter's optional metadata
 * hook. Shared by the `to` and `enrich` steps so the metadata contract has
 * one implementation; `skip` short-circuits when a test override replaced
 * the adapter result (mock results are typically primitives and carry no
 * adapter metadata).
 *
 * The two role slots have distinct hooks, so an adapter never has to sniff
 * which contract it received:
 *
 * - `getMetadata(result, exchange)` fires for fetch-resolved steps
 *   (`.enrich()`, or a fetch-only adapter in `.to()`) with the fetched value.
 * - `getSendMetadata(receipts, exchange)` fires for send-resolved `.to()`
 *   steps with the receipt-header record collected from the
 *   {@link SendContext} sink, or `undefined` when the send set no receipts.
 *
 * Both hooks also receive the exchange the call ran against. Step instances
 * (and the adapters they hold) are shared across every exchange on a route,
 * so an adapter must derive per-call metadata from this argument rather than
 * stashing it on `this` during the call: with concurrent exchanges in flight,
 * instance state written by one call is routinely read back by another.
 *
 * `.tap()` never collects metadata (it runs detached; see TapStep).
 *
 * @internal
 */
export function extractOutcomeMetadata(
  adapter: Adapter,
  result: unknown,
  skip: boolean,
  hook: "getMetadata" | "getSendMetadata" = "getMetadata",
  exchange?: Exchange<unknown>,
): StepOutcomeMetadata | undefined {
  if (skip) return undefined;
  const extract = (
    adapter as Partial<
      Record<
        typeof hook,
        (result: unknown, exchange?: Exchange<unknown>) => StepOutcomeMetadata
      >
    >
  )[hook];
  if (!extract) return undefined;
  // Best-effort: metadata is advisory (event-payload enrichment only). A
  // throwing hook must not turn an adapter operation that already
  // succeeded (and may have had side effects) into a route failure.
  try {
    return extract.call(adapter, result, exchange);
  } catch {
    return undefined;
  }
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
 * - `suspend`: park `exchange` durably and exit the pipeline, to be resumed
 *   later at the next step. Produced by `.suspend()`. The executor
 *   serializes the exchange, writes the suspension, emits
 *   `route:exchange:suspended`, and schedules nothing further for it;
 *   `request` carries what it needs to do that (the `expect` schema, the
 *   TTL, and where the suspend sits in the route). Only the framework's own
 *   suspend step can produce a coherent `request`, so a custom step
 *   returning this kind without one is rejected with `RC5032` rather than
 *   silently dropping the exchange.
 *
 * The union is OPEN across minor releases: new kinds may be added as the
 * engine grows (the executor exhaustively handles every kind it ships
 * with). Code that consumes outcomes (custom wrappers, tests) should pass
 * unrecognised kinds through rather than throwing on them.
 */
export type StepOutcome =
  | { kind: "continue"; exchange: Exchange; metadata?: StepOutcomeMetadata }
  | { kind: "complete"; exchange: Exchange; metadata?: StepOutcomeMetadata }
  | { kind: "drop"; metadata?: StepOutcomeMetadata }
  | { kind: "branch"; exchange: Exchange; steps: Step<Adapter>[] }
  | { kind: "fanOut"; exchanges: Exchange[] }
  | { kind: "suspend"; exchange: Exchange; request: SuspendRequest };

/**
 * The abort surface of a step execution, handed to function-form steps
 * (`.process()`, `.transform()`, `.to()`, `.enrich()`) as their trailing
 * argument. {@link StepContext} extends it, so adapter authors
 * implementing {@link Step.execute} read the same field from `ctx`.
 *
 * `signal` fires when an enclosing `.timeout()` deadline expires (step
 * scope or route scope): promises cannot be cancelled, so the framework
 * discards the losing run's outcome, and this signal is how the run
 * itself finds out. Forward it into cancellation-aware IO (`fetch`, DB
 * drivers) so abandoned work actually stops instead of running to
 * completion in the background:
 *
 * ```ts
 * .timeout(3000)
 * .process(async (ex, { signal }) => {
 *   const res = await fetch(url, { signal });
 *   return { ...ex, body: await res.json() };
 * })
 * ```
 *
 * The signal's abort reason is the `RC5011` timeout error. It is absent
 * when no timeout wraps the step. Route shutdown does NOT fire it:
 * graceful drain lets in-flight exchanges complete (sources observe
 * shutdown via their own `Subscription.signal`).
 */
export interface StepSignalContext {
  /** Fires when an enclosing `.timeout()` deadline expires. */
  readonly signal?: AbortSignal;
}

/**
 * Narrow a {@link StepContext} down to its abort surface for handing to
 * user code. Function-form steps (`.process()`, `.transform()`, `.to()`,
 * `.enrich()`) pass THIS to their callables instead of the executor's
 * full context: the narrowing is a deliberate capability boundary (only
 * `signal` may reach user code, never scheduling capabilities like
 * `takePending`), so every call site funnels through here rather than
 * re-spelling the spread.
 *
 * @internal
 */
export function toSignalContext(ctx?: StepContext): StepSignalContext {
  return ctx?.signal ? { signal: ctx.signal } : {};
}

/**
 * Narrow executor capability handed to {@link Step.execute}.
 *
 * `takePending` atomically removes and returns pending sibling exchanges
 * matching the predicate; it exists for join-style steps (aggregate) that
 * consume their split siblings. The queue itself is never exposed, so
 * steps cannot reorder, duplicate, or corrupt scheduling.
 *
 * Extends {@link StepSignalContext}: `signal` fires when an enclosing
 * `.timeout()` deadline expires, so steps doing cancellation-aware IO
 * can abort abandoned work.
 */
export interface StepContext extends StepSignalContext {
  takePending(predicate: (exchange: Exchange) => boolean): Exchange[];

  /**
   * Run each provided sub-pipeline against its own exchange, all in
   * parallel, resolving once every path has settled (`Promise.allSettled`
   * semantics: one path throwing does not reject the call). Each path runs
   * as an isolated nested pipeline whose failure fires that exchange's
   * default error events (the caller's route-scope `.error()` handler does
   * NOT run for a path) but does not affect the caller or sibling paths.
   * The queue itself stays private, so a fan-out step (e.g. `multicast`)
   * cannot reorder or corrupt the parent's scheduling.
   */
  runPaths(
    runs: ReadonlyArray<{ steps: Step<Adapter>[]; exchange: Exchange }>,
  ): Promise<void>;

  /**
   * Run ONE sub-pipeline against its own exchange as an isolated nested run,
   * resolving with the run's outcome. Like a single {@link runPaths} entry,
   * but the result is reported back rather than swallowed, so a caller (e.g.
   * `dispatch`'s `failover` strategy) can decide what to do next based on
   * whether the run failed or was deliberately dropped. A failing path still
   * fires that exchange's default error events (the caller's route-scope
   * `.error()` handler does NOT run for it) and never rejects this call.
   */
  runPath(run: { steps: Step<Adapter>[]; exchange: Exchange }): Promise<{
    failed: boolean;
    dropped: boolean;
    error?: unknown;
    /**
     * True when an outer abort signal (a route-scope timeout abandoning the
     * attempt) truncated the run before or while it was scheduling steps.
     * An aborted run is neither a success nor a target failure; callers
     * (dispatch failover) must not treat it as a handled exchange.
     */
    aborted?: boolean;
  }>;

  /**
   * Capture the downstream continuation for the currently-executing step:
   * returns a runner that, when later invoked with an exchange, runs it
   * through the steps that FOLLOW this one as a detached, route-tracked
   * pipeline (with its own `exchange:started` / `:completed` lifecycle).
   *
   * Snapshot it synchronously inside `execute`; the runner stays valid after
   * `execute` resolves. Used by `debounce` to release a held exchange after
   * its quiet window closes without re-running the steps before it. Because
   * the released exchange is the route's PRIMARY flow (not a side-effect
   * clone), the detached run honors the route-scope `.error()` handler and
   * enforces the route's `.output()` schemas before completing, and it
   * inherits no abort signal from the capturing attempt.
   */
  captureDownstream(): (
    exchange: Exchange,
  ) => Promise<{ failed: boolean; dropped: boolean }>;
}

// MessageChannel lives with channel adapter now

/**
 * Construction dependencies handed to a {@link Consumer} by the route
 * runtime, one bag per (source, consumer) pair.
 *
 * `options` is deliberately `unknown` here: route definitions store
 * heterogeneous consumer configurations, so the typed options surface
 * lives on the builder method that stages the consumer (e.g.
 * `.batch(...)`). Each consumer narrows and defaults its own options in
 * its constructor; it owns the interpretation of that value.
 */
export type ConsumerDeps = {
  context: CraftContext;
  definition: RouteDefinition;
  channel: ProcessingQueue<Message>;
  options: unknown;
};

/**
 * Constructable consumer class. The single deps-bag parameter (rather
 * than positional arguments) keeps every consumer class assignable to
 * `ConsumerType<Consumer>` without casts, so route definitions can store
 * any consumer implementation uniformly.
 */
export type ConsumerType<T extends Consumer = Consumer> = (new (
  deps: ConsumerDeps,
) => T) & {
  /**
   * The consumer may hold a message before the pipeline runs, the way
   * `.batch()` fills a buffer. A held message is not the route's in-flight
   * work, so a graceful shutdown can drain past it, and a transport that
   * answers its caller before the pipeline finishes cannot promise the
   * delivery will run. Declared by the consumer rather than inferred from
   * its class, so a new consumer states its own answer instead of an
   * unrelated file guessing.
   */
  readonly buffers?: boolean;
};

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
  channel: ProcessingQueue<Message>;
  definition: RouteDefinition;
  options: O;
  /**
   * Register the route handler. The handler receives the same
   * {@link Message} envelope that sources enqueue, so a pass-through
   * consumer forwards it untouched while merging consumers (e.g. batch)
   * synthesize new envelopes. At runtime the envelope's `message` and the
   * returned exchange's body are untyped (unknown); the builder chain is
   * typed, so narrow or assert in the handler if you need body fields.
   *
   * When the envelope carries a `parse` function the route captures it on
   * the exchange internals so `runPipeline` can apply it as a synthetic
   * first pipeline step. Consumers that merge multiple messages parse
   * items eagerly during enqueue and hand over a `parse`-less envelope.
   */
  register(handler: (envelope: Message) => Promise<Exchange>): void;
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
  /**
   * Shutdown finished. `forced` is true when stage one did not drain inside
   * `shutdown.timeout` and in-flight execution was abandoned, with
   * `pending` naming the routes that still had work. A clean stop carries
   * `forced: false` and an empty `pending`, so the shape is stable and a
   * subscriber can count forced shutdowns without reading exit codes.
   */
  "context:stopped": { forced: boolean; pending: string[] };
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
  /**
   * A route's enablement predicate was evaluated and the verdict CHANGED
   * (or was reached for the first time). Not emitted when a refresh
   * re-confirms what the route was already doing, so a five-minute cadence
   * on a stable predicate is silent rather than a heartbeat.
   *
   * `reason` is present only when `enabled` is false, and is what ops
   * reports next to the route.
   */
  "route:enablement:changed": {
    routeId: string;
    route: Route;
    enabled: boolean;
    reason?: string;
  };
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
  /**
   * A source subscription rejected: the source gave up producing (e.g. a
   * connection-backed source exhausted its reconnect attempts) and the route
   * is about to stop. Distinct from `route:stopping`, which also fires for
   * orderly shutdowns; subscribe to this one to alarm on a dead channel.
   */
  "route:source:failed": {
    routeId: string;
    route: Route;
    /** `adapterId` of the failed source, when the adapter declares one. */
    adapter?: string;
    error: unknown;
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
  /**
   * The exchange parked at a `.suspend()` and execution one ended. This is
   * that run's terminal event, in place of `:completed`: the body the
   * source receives is the `Suspended` acknowledgment, and the route's real
   * output flows on execution two.
   */
  "route:exchange:suspended": ExchangeScoped & {
    suspensionId: string;
    /** Address of the suspending step; the continuation is what follows it. */
    position: number;
    /** When the suspension stops being resumable, when a `ttl` was declared. */
    expiresAt?: Date;
  };
  /**
   * A parked exchange was revived and its continuation is about to run.
   * Execution two's `:started` follows immediately, and that run gets its
   * own `:completed` / `:failed` / `:dropped`.
   */
  "route:exchange:resumed": ExchangeScoped & {
    suspensionId: string;
    position: number;
    /** Who resumed it, when the resume ingress had an authenticated principal. */
    resumedBy?: PrincipalRef;
  };
  /**
   * A suspension stopped being resumable because its `ttl` elapsed. Fires
   * when a late resume discovers it, and (once the sweeper lands) when the
   * sweeper reaches it first. The suspended route's error channel receives
   * `RC5047` alongside, which is where a re-ask belongs.
   */
  "route:exchange:expired": ExchangeScoped & {
    suspensionId: string;
    expiresAt: Date;
  };

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

  // -- Retry (route- and step-scope wrapper) --
  "route:retry:started": ExchangeScoped & {
    /** Label of the wrapped step, or `"route"` when `scope === "route"`. */
    stepLabel: string;
    scope: "route" | "step";
    maxAttempts: number;
  };
  /** A failed attempt will be re-attempted after `backoffMs`. */
  "route:retry:attempt": ExchangeScoped & {
    stepLabel: string;
    scope: "route" | "step";
    attemptNumber: number;
    maxAttempts: number;
    /** Actual wait before the next attempt (factor growth + jitter applied). */
    backoffMs: number;
    lastError?: unknown;
  };
  "route:retry:stopped": ExchangeScoped & {
    stepLabel: string;
    scope: "route" | "step";
    attemptNumber: number;
    success: boolean;
    /**
     * Present when `success` is false: the raw error that caused the
     * final failure (non-retryable error, exhausted attempts, or the
     * last failure when shutdown interrupted the backoff).
     */
    error?: unknown;
  };

  // -- Delay (step-scope wrapper) --
  "route:delay:started": ExchangeScoped & {
    stepLabel: string;
    scope: "step";
    delayMs: number;
  };
  "route:delay:stopped": ExchangeScoped & {
    stepLabel: string;
    scope: "step";
    delayMs: number;
    elapsed: number;
    /** True when route shutdown cut the wait short (the step still ran). */
    cancelled: boolean;
  };

  // -- Timeout (route- and step-scope wrapper) --
  "route:timeout:started": ExchangeScoped & {
    /** Label of the wrapped step, or `"route"` when `scope === "route"`. */
    stepLabel: string;
    scope: "route" | "step";
    timeoutMs: number;
  };
  /** The deadline fired before the guarded execution settled; RC5011 follows. */
  "route:timeout:expired": ExchangeScoped & {
    stepLabel: string;
    scope: "route" | "step";
    timeoutMs: number;
    elapsed: number;
  };
  /** The guarded execution settled within the deadline. */
  "route:timeout:stopped": ExchangeScoped & {
    stepLabel: string;
    scope: "route" | "step";
    timeoutMs: number;
    elapsed: number;
  };

  // -- Throttle (route- and step-scope wrapper) --
  /** No token was free; the exchange will wait `waitMs` before admission (delay mode). */
  "route:throttle:delayed": ExchangeScoped & {
    /** Label of the wrapped step, or `"route"` when `scope === "route"`. */
    stepLabel: string;
    scope: "route" | "step";
    /** Pacing wait applied before this exchange is admitted. */
    waitMs: number;
    /** Partition key the exchange was charged against, when `key` is set. */
    key?: string;
    /** Gate label, when `.throttle({ label })` is set. */
    label?: string;
  };
  /** The exchange was admitted through the rate limiter. */
  "route:throttle:passed": ExchangeScoped & {
    stepLabel: string;
    scope: "route" | "step";
    /** True when the exchange had to wait for a token before admission. */
    waited: boolean;
    /** Total time spent in the throttle gate (0 on the fast path). */
    elapsed: number;
    /** Partition key the exchange was charged against, when `key` is set. */
    key?: string;
    /** Gate label, when `.throttle({ label })` is set. */
    label?: string;
  };
  /** The exchange exceeded the rate and was rejected (reject mode); `RC5013` follows. */
  "route:throttle:rejected": ExchangeScoped & {
    stepLabel: string;
    scope: "route" | "step";
    /** Time until a token would free, for a Retry-After style hint. */
    retryAfterMs: number;
    /** Partition key the exchange was charged against, when `key` is set. */
    key?: string;
    /** Gate label, when `.throttle({ label })` is set. */
    label?: string;
  };

  // -- Circuit breaker (route- and step-scope wrapper) --
  /** The breaker tripped to open: failures reached the threshold (from closed) or a probe failed (from half-open). */
  "route:circuitBreaker:opened": ExchangeScoped & {
    /** Label of the wrapped step, or `"route"` when `scope === "route"`. */
    stepLabel: string;
    scope: "route" | "step";
    /** Counted failures in the window at the moment the breaker tripped. */
    failureCount: number;
    /** Configured failure threshold. */
    threshold: number;
    /** Cooldown before the breaker will admit a probe (half-open). */
    cooldownMs: number;
    /** Breaker label, when `.circuitBreaker({ label })` is set. */
    label?: string;
  };
  /** Cooldown elapsed; the breaker admitted a probe call to test recovery. */
  "route:circuitBreaker:halfOpen": ExchangeScoped & {
    stepLabel: string;
    scope: "route" | "step";
    label?: string;
  };
  /** A probe succeeded; the breaker recovered to closed. */
  "route:circuitBreaker:closed": ExchangeScoped & {
    stepLabel: string;
    scope: "route" | "step";
    label?: string;
  };
  /** A call was rejected because the breaker is open (or half-open at capacity); a `fallback` ran or `RC5025` followed. */
  "route:circuitBreaker:rejected": ExchangeScoped & {
    stepLabel: string;
    scope: "route" | "step";
    /** Breaker state at rejection time. */
    state: "open" | "half-open";
    /** Time until the breaker would admit a probe, for a Retry-After style hint (0 when half-open at capacity). */
    retryAfterMs: number;
    label?: string;
  };

  // -- Concurrency / bulkhead (route- and step-scope wrapper) --
  /** All slots were busy; the exchange joined the wait queue (queue mode). */
  "route:concurrency:queued": ExchangeScoped & {
    /** Label of the wrapped step, or `"route"` when `scope === "route"`. */
    stepLabel: string;
    scope: "route" | "step";
    /** The exchange's position in the wait queue (1 = next to be admitted). */
    queueDepth: number;
    /** Partition key the exchange was charged against, when `key` is set. */
    key?: string;
    /** Limiter label, when `.concurrency({ label })` is set. */
    label?: string;
  };
  /** A slot was acquired and the wrapped work began. */
  "route:concurrency:acquired": ExchangeScoped & {
    stepLabel: string;
    scope: "route" | "step";
    /** True when the exchange had to queue before a slot freed. */
    waited: boolean;
    /** Slots in use (including this one) at admission time. */
    inUse: number;
    key?: string;
    label?: string;
  };
  /** The held slot was released (work settled: success, drop, or failure). */
  "route:concurrency:released": ExchangeScoped & {
    stepLabel: string;
    scope: "route" | "step";
    /** How long the work held the slot, in milliseconds. */
    heldMs: number;
    key?: string;
    label?: string;
  };
  /** The exchange was failed fast with `RC5026`; `RC5026` follows. */
  "route:concurrency:rejected": ExchangeScoped & {
    stepLabel: string;
    scope: "route" | "step";
    /** `"busy"`: reject mode, all slots in use. `"queue-full"`: queue mode, wait line at `maxQueue`. */
    reason: "busy" | "queue-full";
    key?: string;
    label?: string;
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

  // -- Multicast --
  /** Fan-out started: the exchange is about to be cloned to each path. */
  "route:operation:multicast:started": ExchangeScoped & {
    /** Number of paths the exchange is fanned out to. */
    pathCount: number;
  };
  /** Fan-out finished: every path has settled and the original continues. */
  "route:operation:multicast:stopped": ExchangeScoped & {
    pathCount: number;
  };

  // -- Dispatch --
  /** A target was selected to run. For `failover`, fired once per attempt. */
  "route:operation:dispatch:selected": ExchangeScoped & {
    /**
     * The strategy that made the pick. Inlines `DispatchStrategyName`
     * (operations/dispatch.ts): this file is the dependency root and never
     * imports from operations, so keep the two unions in sync.
     */
    strategy: "failover" | "round-robin" | "weighted" | "sticky";
    /** Index of the selected target in the `.dispatch()` target list. */
    targetIndex: number;
  };
  /** `failover` ran out of targets: every one failed and none handled the exchange. */
  "route:operation:dispatch:exhausted": ExchangeScoped & {
    strategy: "failover";
    /** How many targets were tried before giving up. */
    targetCount: number;
  };

  // -- Sample --
  /** The sampler admitted this exchange. */
  "route:operation:sample:passed": ExchangeScoped & {
    /** `"count"` for `every`-based sampling, `"interval"` for `intervalMs`. */
    mode: "count" | "interval";
  };
  /** The sampler dropped this exchange (between samples). */
  "route:operation:sample:dropped": ExchangeScoped & {
    mode: "count" | "interval";
  };

  // -- Dedupe --
  /** The key was unseen; it is reserved and the exchange continues. */
  "route:operation:dedupe:pass": ExchangeScoped & {
    /** The derived key reserved for this exchange. */
    key: string;
  };
  /** The key was already reserved or committed; the exchange is dropped. */
  "route:operation:dedupe:duplicate": ExchangeScoped & {
    /** The derived key that was already seen. */
    key: string;
  };

  // -- Debounce --
  /** An exchange entered the debounce window and is being held (timer armed/reset). */
  "route:operation:debounce:held": ExchangeScoped & {
    /** The partition key the exchange was held under, when `key` is set. */
    key?: string;
  };
  /** A held exchange was superseded by a newer arrival in the same burst and dropped. */
  "route:operation:debounce:dropped": ExchangeScoped & {
    key?: string;
  };
  /** The quiet window (or `maxWait` cap) elapsed; the last held exchange is released downstream. */
  "route:operation:debounce:released": ExchangeScoped & {
    key?: string;
    /**
     * Why the exchange was released: `"quiet"` when the `waitMs` window
     * closed, `"maxWait"` when the `maxWaitMs` cap fired during continuous
     * activity, or `"flush"` when a drain / shutdown released it early.
     */
    reason: "quiet" | "maxWait" | "flush";
  };

  // -- Agent (emitted by @routecraft/ai agent() destinations) --
  // Sensitive payloads (tool input/output, thrown errors that may echo
  // them) ride in the `_snapshot` envelope: the bus always carries them,
  // but the telemetry sink persists them only when snapshot capture is on.
  "route:agent:started": ExchangeScoped & {
    agentName?: string;
    model: string;
    toolNames: string[];
    maxTurns: number;
  };
  /**
   * A tool was refused admission to an agent's tool list by
   * `agentPlugin({ toolPolicy })` and never offered to the model.
   *
   * Emitted once per denied tool per dispatch, alongside whichever log
   * that denial produced: `warn` when a rule decided against the tool,
   * `error` when a rule threw (the tool is denied to fail closed, and
   * the warn line is suppressed so one failure is not reported twice).
   * The two channels serve different consumers: the log is for someone
   * reading text, the event is for alerting and audit, which is what a
   * policy decision needs to be queryable from.
   *
   * `reason` distinguishes a rule that decided against the tool from a
   * rule that threw (denied to fail closed) and from provenance the
   * resolver could not classify. `unknown-provenance` covers every tool
   * whose `source` is missing or carries a kind the policy surface does
   * not define, since no rule runs in either case; `toolKind` is
   * reported as `"unknown"` for both.
   */
  "route:agent:tool:denied": ExchangeScoped & {
    agentName?: string;
    toolName: string;
    toolKind: string;
    reason: "rule" | "rule-error" | "unknown-provenance";
  };
  /**
   * A call the model made was refused by the tool's guard, at call time,
   * on a tool the model could see and was allowed to attempt.
   *
   * Distinct from `denied`, which fires when a policy withholds a tool at
   * selection time so the model never sees it. Counting the two together
   * would mix "this agent may not have that tool" with "this agent asked
   * for something its grant does not cover", and it is the second that
   * tells an operator an agent is probing the edges of its allowlist.
   * That signal is the whole reason an allowlist is worth auditing.
   *
   * The payload is deliberately bounded to identity plus the error code.
   * The refused input is what carries the secret material (a command line
   * can hold a token someone passed as an argument), and a refusal is
   * exactly the case where that input is least trustworthy, so it is not
   * carried here even under snapshot capture.
   */
  "route:agent:tool:refused": ExchangeScoped & {
    toolCallId: string;
    toolName: string;
    /** Error code when the guard threw a Routecraft error, e.g. `RC5002`. */
    rc?: string;
  };
  "route:agent:tool:invoked": ExchangeScoped & {
    toolCallId: string;
    toolName: string;
    _snapshot: { input: unknown };
  };
  "route:agent:tool:result": ExchangeScoped & {
    toolCallId: string;
    toolName: string;
    _snapshot: { output: unknown };
    duration: number;
  };
  "route:agent:tool:error": ExchangeScoped & {
    toolCallId: string;
    toolName: string;
    errorName: string;
    _snapshot: { error: unknown };
    duration: number;
  };
  "route:agent:block:loaded": ExchangeScoped & {
    toolCallId: string;
    blockName: string;
    _snapshot: { output: unknown };
    duration: number;
  };
  "route:agent:block:error": ExchangeScoped & {
    toolCallId: string;
    blockName: string;
    errorName: string;
    _snapshot: { error: unknown };
    duration: number;
  };
  "route:agent:finished": ExchangeScoped & {
    agentName?: string;
    model: string;
    finishReason: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  /**
   * Emitted after every successful agent dispatch alongside
   * `route:agent:finished`. Carries the full token breakdown for the
   * dispatch so consumers can compute cost without subscribing to the
   * broader lifecycle event.
   *
   * Cache fields are present only when the provider reports them (e.g.
   * Anthropic with prompt caching enabled).
   */
  "route:agent:usage": ExchangeScoped & {
    agentName?: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  "route:agent:error": ExchangeScoped & {
    agentName?: string;
    model: string;
    error: unknown;
  };

  // -- Agent sessions (emitted by @routecraft/ai for agent() dispatches
  // that carry `session`). `agentName` is the session's agent: the
  // registered name, or the route id for an inline agent.
  /**
   * A message arrived for a session whose turn is running and was queued
   * for the next turn boundary. The caller was acknowledged, not answered.
   */
  "route:agent:session:queued": ExchangeScoped & {
    agentName: string;
    session: string;
    /** Inbox depth after this message was appended. */
    depth: number;
    /** The message asked for the running turn to be interrupted. */
    interrupt: boolean;
  };
  /** A running turn was cancelled by a later message with `interrupt: true`. */
  "route:agent:session:interrupted": ExchangeScoped & {
    agentName: string;
    session: string;
  };
  /**
   * A turn started on a session whose previous turn was cut short by a
   * restart: its partial transcript was kept, its inbox was intact, and
   * every background call it was waiting on was reported lost.
   */
  "route:agent:session:restored": ExchangeScoped & {
    agentName: string;
    session: string;
    lostBackground: number;
  };
  /**
   * A turn ended with work outstanding (background calls running, or
   * messages queued), so its exchange's continuation was stored: what a
   * completion, the queued messages, or a boot revives to run the next
   * turn and the route's downstream steps.
   */
  "route:agent:session:parked": ExchangeScoped & {
    agentName: string;
    session: string;
    suspensionId: string;
    /** Messages waiting when the park was stored. */
    inbox: number;
    /** Background calls still running when the park was stored. */
    background: number;
  };
  /**
   * A stored continuation was revived and this turn is the one it runs:
   * the inbox is its user message and the route's downstream steps follow.
   * Emitted on the revived exchange, after core's `route:exchange:resumed`.
   */
  "route:agent:session:revived": ExchangeScoped & {
    agentName: string;
    session: string;
    suspensionId: string;
  };
  /** A background tool dispatched its route and returned a handle to the model. */
  "route:agent:session:background:started": ExchangeScoped & {
    agentName: string;
    session: string;
    handle: string;
    toolName: string;
  };
  /** A background tool's route finished and its result was posted to the session inbox. */
  "route:agent:session:background:completed": ExchangeScoped & {
    agentName: string;
    session: string;
    handle: string;
    toolName: string;
    duration: number;
  };
  /** A background tool's route failed and the failure was posted to the session inbox. */
  "route:agent:session:background:failed": ExchangeScoped & {
    agentName: string;
    session: string;
    handle: string;
    toolName: string;
    errorName: string;
    duration: number;
  };

  // -- Agent / tool registration (emitted once per registered agent / fn
  // on context:started by agentPlugin in @routecraft/ai, so observability
  // consumers can list agents and tools before any of them runs) --
  "agent:registered": {
    agentId: string;
    description?: string;
    model?: string;
    source: "registered";
  };
  "agent:tool:registered": {
    toolName: string;
    description?: string;
    tags?: string[];
    source: "registered";
  };

  // -- Named servers (shared web ingress) --
  "server:listening": { server: string; port: number; host: string };
  "server:failed": { server: string; error: unknown };
  "server:closed": { server: string };

  // -- HTTP plugin --
  /**
   * A health component changed status, so an operator can alert on the
   * transition rather than polling for it. The ops listener's own lifecycle
   * is reported by the server events above, since the ops surface mounts on a
   * named server rather than owning a socket.
   */
  "plugin:ops:health:changed": HealthChange;
  "plugin:http:request:completed": {
    method: string;
    path: string;
    status: number;
    durationMs: number;
    routeId?: string;
    principal?: { subject: string } | undefined;
    /**
     * Why a streaming response ended badly, when it did.
     *
     * A stream fails after its status line is already on the wire, so
     * `status` still reports what was sent and cannot say the response
     * broke. Without this an operator counting completions would score a
     * truncated stream as a 200 success, and only the logs would disagree.
     * Absent on every response that completed normally.
     */
    error?: { name: string; message: string };
  };

  // -- Plugin lifecycle --
  /** The plugin's `apply()` hook is about to run, at context build time. */
  "plugin:applying": { pluginId: string; pluginIndex: number };
  /** The plugin's `apply()` hook returned. */
  "plugin:applied": { pluginId: string; pluginIndex: number };
  /**
   * The plugin's `start()` hook is about to run, after every route has
   * signalled readiness or the readiness backstop elapsed, so it is not
   * proof that every source is listening.
   * Until 0.7 this pair bracketed `apply()`; that phase is now
   * `plugin:applying` / `plugin:applied`, so the event vocabulary matches
   * the lifecycle: applying, starting, stopping.
   */
  "plugin:starting": { pluginId: string; pluginIndex: number };
  /** The plugin's `start()` hook resolved. */
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
 * Event names whose payload carries a `routeId`, i.e. the events
 * {@link forRoute} can meaningfully filter. Subscribing `forRoute` to a
 * route-less event (context, auth, plugin lifecycle) would silently never
 * fire, so the constraint makes that a compile error instead.
 */
export type RouteScopedEventName = {
  // Key presence (not `extends { routeId: string }`) so events with an
  // OPTIONAL routeId (e.g. plugin:http:request:completed) stay filterable.
  [K in EventName]: "routeId" extends keyof EventDetailsMap[K] ? K : never;
}[EventName];

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
export function forRoute<K extends RouteScopedEventName>(
  routeId: string,
  handler: EventHandler<K>,
): EventHandler<K> {
  return (payload) => {
    if (payload.details.routeId === routeId) {
      return handler(payload);
    }
    return undefined;
  };
}
