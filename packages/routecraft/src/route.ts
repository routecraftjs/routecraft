import { DIRECT } from "./kernel/direct.ts";
import { randomUUID } from "node:crypto";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { CraftContext } from "./context.ts";
import {
  type Exchange,
  HeadersKeys,
  OperationType,
  type ExchangeHeaders,
  DefaultExchange,
  EXCHANGE_INTERNALS,
  isDropped,
} from "./exchange.ts";
import type { RegisteredDirectEndpoint } from "./registry.ts";
import {
  resolveAdapterOverride,
  wrapSourceWithOverride,
} from "./testing-hooks.ts";
import { BRAND, INTERNALS_KEY, setBrand } from "./brand.ts";
import { rcError, RC } from "./error.ts";
import { isRoutecraftError } from "./brand.ts";
import { logger, childBindings } from "./logger.ts";
import type { Source, Subscription } from "./operations/from.ts";
import type { ResolvedRetryOptions } from "./operations/retry-wrapper.ts";
import type { ResolvedTimeoutOptions } from "./operations/timeout-wrapper.ts";
import type { ResolvedCircuitBreakerOptions } from "./operations/circuit-breaker-wrapper.ts";
import type { ResolvedConcurrencyOptions } from "./operations/concurrency-wrapper.ts";
import type { ResolvedThrottleOptions } from "./operations/throttle-wrapper.ts";
import type { ResolvedCacheOptions } from "./operations/cache-wrapper.ts";
import type { AuthorizeOptions } from "./authorize-options.ts";
import type {
  Adapter,
  Step,
  Consumer,
  ConsumerType,
  Message,
  ProcessingQueue,
} from "./types.ts";
import { InMemoryProcessingQueue } from "./queue.ts";
import {
  buildCacheCheckStep,
  buildCacheStoreStep,
  buildThrottleCheckStep,
} from "./pipeline/synthetic-steps.ts";
import {
  applyOutputStage,
  validateInputOrThrow,
  type ValidationDeps,
} from "./pipeline/validation.ts";
import {
  applyExitSlot,
  detachedSlots,
  runDetachedPipeline,
  runPipeline,
  type DetachedResult,
  type ExecutorDeps,
  type RouteSlots,
} from "./pipeline/executor.ts";
import { buildSlotStep, routeTags } from "./kernel/hooks.ts";
import {
  compilePositions,
  type CompiledPositions,
} from "./pipeline/positions.ts";
import {
  detachedDefinition,
  type DetachedKind,
} from "./pipeline/chain-policy.ts";
import type {
  DeferCapableStep,
  DeferrableStep,
  DeferSite,
  ErrorPathSite,
} from "./kernel/continuation/sites.ts";
import { nestedStepsOf } from "./kernel/continuation/sites.ts";
import { STEP_PLUGIN } from "./dsl-symbol.ts";
import type { WrapperStep } from "./operations/wrapper.ts";
import { DeferralHeaders } from "./kernel/continuation/exchange-state.ts";
import type { RouteEnablement } from "./enablement.ts";

// Re-exported for existing imports (builder.ts and @internal consumers).
export { buildCacheCheckStep, buildCacheStoreStep, buildThrottleCheckStep };

/**
 * Header keys that belong to ONE exchange and never to the next, stripped at
 * every route ingress by {@link DefaultRoute.buildExchange}.
 *
 * The deferral keys are per-exchange state like the split hierarchy, and an
 * ingress is a new exchange. `forward()` and a `direct()` destination hand the
 * target the caller's headers verbatim, so without the strip a continuation
 * forwarding anywhere would tell the target it is execution two, hand it
 * another exchange's resume payload, and suppress its own park with a
 * refusal recorded against unrelated work.
 *
 * Built from {@link DeferralHeaders} rather than listed, because the list and
 * the keys drifting apart is silent: the stripping site is nowhere near the
 * declaration, and a key that keeps its value across an ingress tells the
 * receiving route it is a continuation of work it never did.
 */
const PER_EXCHANGE_HEADERS: ReadonlySet<string> = new Set<string>([
  HeadersKeys.SPLIT_HIERARCHY,
  ...Object.values(DeferralHeaders),
]);

/**
 * Function that forwards a payload to another route via the direct adapter and returns its result.
 *
 * @param endpoint - The target route's direct endpoint
 * @param payload - The data to send
 * @returns The result of the target route's pipeline
 */
export type ForwardFn = (
  endpoint: RegisteredDirectEndpoint,
  payload: unknown,
) => Promise<unknown>;

/**
 * Error handler invoked when a step in the route pipeline throws an unhandled error.
 *
 * The pipeline does not resume after this handler runs. The handler's return value
 * becomes the route's final exchange body. Use `forward` to delegate to another route.
 *
 * Instead of a recovery body the handler may return a branded `Recovery`
 * directive built with the `recovery` helpers (see `recovery.ts`):
 * `recovery.drop(reason?)` discards the exchange (emits
 * `route:exchange:dropped`, no `route:exchange:completed`), and
 * `recovery.rethrow()` propagates the original error exactly as if the
 * handler had thrown it, and `recovery.defer(request)` parks the exchange
 * durably and answers with the `Deferred` acknowledgment. Plain (unbranded)
 * return values are unaffected.
 *
 * @param error - The thrown error
 * @param exchange - The exchange at the point of failure
 * @param forward - Sends a payload to another route via the direct adapter
 * @returns Static fallback value, result of forward(), or a `Recovery` directive
 */
/** Options of a route-scope `.error(handler, options)`. */
export interface RouteErrorOptions {
  /**
   * What a resume payload must satisfy when the handler parks the exchange
   * with `recovery.defer()`. Declared here rather than in the handler so the
   * resume door can read it back live and validate against it (`RC5049`);
   * a changed or removed schema refuses the resume (`RC5048`).
   */
  readonly schema?: StandardSchemaV1;
}

export type ErrorHandler = (
  error: unknown,
  exchange: Exchange,
  forward: ForwardFn,
) => unknown | Promise<unknown>;

/**
 * What a context handler is told about the failure beyond the failure itself.
 *
 * An object rather than the bare {@link Route} it started as, because `error`
 * is the one handler point locked to a positional signature: a fourth slot
 * holding a `Route` could never gain a field without breaking every handler
 * already written against it.
 */
export interface ErrorContext {
  /** The route the failing exchange belongs to. */
  readonly route: Route;
  /**
   * `1` on the exchange's first run, `2` once it is a resumed continuation.
   *
   * A handler that parks on a failure needs to know it is looking at the
   * resumed run rather than the original, or a failure the resume itself
   * causes parks the same exchange again and the human is asked twice. An
   * exchange that parks a second time and resumes again stays `2`: the
   * distinction is original against continuation, not a park counter, which
   * `ex.deferral.sequence` already is.
   */
  readonly execution: 1 | 2;
}

/**
 * Per-direction schema bundle for discoverable-capability routes. Mirrors the
 * Standard Schema shape used by adapters; the engine enforces `input` before
 * pipeline steps run and `output` before the primary destination fires.
 */
export interface RouteSchemas {
  /** Standard Schema for the body. */
  body?: StandardSchemaV1;
  /** Standard Schema for the headers. */
  headers?: StandardSchemaV1;
}

/**
 * Well-known tag values surfaced as autocomplete suggestions while still
 * accepting any user-defined string. Use these consistently to enable
 * downstream filtering (e.g. an agent that only whitelists `"read-only"`
 * tools).
 */
export type KnownTag =
  "read-only" | "destructive" | "idempotent" | "open-world";

/**
 * Tag value: one of the framework's well-known tags or any user string.
 * The `& {}` keeps autocomplete on `KnownTag` while accepting arbitrary
 * strings.
 */
export type Tag = KnownTag | (string & {});

/**
 * Route-level discovery bundle. Adapters that maintain registries (direct,
 * mcp) mirror these fields into their registry entries; the engine uses
 * `input` / `output` for framework-enforced validation regardless of adapter.
 *
 * Set via the `.title()`, `.description()`, `.input()`, `.output()`,
 * and `.tag()` builder methods. All fields are optional.
 */
export interface RouteDiscovery {
  /** Human-readable display title for discovery consumers (agents, docs). */
  title?: string;
  /** Human-readable description of what this route does. */
  description?: string;
  /** Input schemas runtime-enforced before pipeline steps run. */
  input?: RouteSchemas;
  /** Output schemas runtime-enforced before the primary destination. */
  output?: RouteSchemas;
  /**
   * Tags surfaced on `ToolsCatalog` entries for the builder form of
   * `tools((catalog) => ...)` in `@routecraft/ai`, and on resolved
   * tool entries for downstream inspection. Empty/missing means no
   * tags.
   */
  tags?: Tag[];
}

/**
 * Configuration for a route: source, steps, and consumer.
 *
 * Describes how data flows from a source through processing steps to destinations.
 * The builder preserves body type `T`; at runtime the runnable Route uses `Exchange`
 * and handlers/events receive `Exchange<unknown>` unless you narrow or use `Route<T>`.
 *
 * @template T - Body type produced by the source (flowing through the chain until type-erased at runtime)
 *
 * @example
 * ```typescript
 * const def: RouteDefinition<string> = {
 *   id: 'my-route',
 *   sources: [simple('hello')],
 *   steps: [...],
 *   consumer: { type: SimpleConsumer, options: undefined }
 * };
 * ```
 */
export type RouteDefinition<T = unknown> = {
  /** Unique identifier for the route */
  readonly id: string;

  /**
   * The sources that feed data into the route. A route may expose multiple
   * ingresses (e.g. `direct` for internal callers, `mcp` for agents, `http`
   * for integrations) that all drive the same downstream pipeline. The route
   * stays a single logical entity: one id, one set of lifecycle events, and
   * (where the registries derive a public name from the route id) one name
   * across ingresses. Every entry must be non-empty; the builder normalizes a
   * single `.from(x)` to `[x]`.
   */
  readonly sources: readonly Source<T>[];

  /** Processing steps that transform, filter, or direct the data */
  readonly steps: Step<Adapter>[];

  /** Consumer configuration that determines how data is processed */
  readonly consumer: {
    /** The type of consumer to use */
    type: ConsumerType<Consumer>;

    /** Options for the consumer */
    options: unknown;
  };

  /**
   * Optional error handler invoked when a step throws an unhandled error.
   * If defined, the handler's return value becomes the final exchange body.
   * If not defined, the error is logged and emitted via the error event (current behavior).
   */
  readonly errorHandler?: ErrorHandler;

  /**
   * The resume-payload schema of a park `errorHandler` raises, from
   * `.error(handler, { schema })`. On the definition so the resume door
   * reads it live; a handler's own code cannot be asked.
   */
  readonly errorPathSchema?: StandardSchemaV1;

  /**
   * What the `authorize` position checks, one entry per `.authorize()`
   * call; they AND together in declaration order. The position is filled by
   * the `ENFORCEMENT` port's provider when the route first runs, so a
   * definition is plain configuration shared safely across applications.
   */
  readonly authorize?: readonly AuthorizeOptions[];

  /**
   * Route-scope `.cache()`: the `cacheCheck` position before the pipeline
   * and the `cacheStore` position after it, both filled by the `CACHE`
   * port's provider. A hit completes the exchange without the pipeline.
   */
  readonly cache?: ResolvedCacheOptions;

  /**
   * Optional route-level discovery bundle: title, description, and input /
   * output schemas. Populated via `.title()`, `.description()`, `.input()`,
   * and `.output()` on the route builder. The engine enforces `input` and
   * `output` schemas; discovery-aware adapters (direct, mcp) mirror the
   * metadata into their registries.
   */
  readonly discovery?: RouteDiscovery;

  /**
   * The route's enablement predicate and refresh cadence, from `.enabled()`.
   *
   * Route metadata rather than a filter: it decides whether this route runs
   * at all, per route and per lifecycle, so it never enters the pre-from
   * filter chain and never sees an exchange. Absent means always enabled,
   * which is every route that does not declare one.
   */
  readonly enablement?: RouteEnablement;

  /**
   * True when the route declares a route-entry `.authorize()`. Mirrored to
   * sources via {@link SourceMeta.requiresPrincipal} so identity-capable
   * transports enforce credential verification before dispatching into the
   * route, even on an unwalled mount.
   */
  readonly requiresPrincipal?: boolean;

  /**
   * Route-scope `.retry()` config (pre-from filter chain position #7). It
   * surrounds the chain tail (timeout, cache, user pipeline) and re-runs it
   * on failure. See `.standards/pre-from-filter-chain.md`.
   */
  readonly retry?: ResolvedRetryOptions;

  /**
   * Route-scope `.timeout()` config (pre-from filter chain position
   * #8). Bounds each run of the chain tail below it with a deadline;
   * placed inside `retry` so every attempt gets its own deadline.
   */
  readonly timeout?: ResolvedTimeoutOptions;
  /**
   * Route-scope `.throttle()` limits (pre-from filter chain position #5), in
   * declaration order. Each fills one admission gate and the exchange must
   * pass ALL of them, so stacking AND-combines independent limits (a global
   * ceiling plus a per-principal rate). The gates run once per exchange,
   * outside circuitBreaker / retry / timeout, so a retried attempt never
   * re-acquires a token.
   *
   * @internal
   */
  readonly throttle?: readonly ResolvedThrottleOptions[];

  /**
   * Route-scope `.circuitBreaker()` config (pre-from filter chain position
   * #6). The breaker's failure window and open/half-open machine are per
   * route, built once by the `RESILIENCE` provider. It sits outside retry and
   * timeout, so an open breaker fast-fails before they run and one exhausted
   * run of attempts records one failure, not one per retry.
   *
   * @internal
   */
  readonly circuitBreaker?: ResolvedCircuitBreakerOptions;

  /**
   * Route-scope `.concurrency()` bulkheads, one per call; they nest with the
   * first declared outermost. The slot pools are per route, built once by
   * the `RESILIENCE` provider. Innermost of the resilience positions, so a
   * slot is held per attempt and never while a retry sleeps.
   *
   * @internal
   */
  readonly concurrency?: readonly ResolvedConcurrencyOptions[];

  /**
   * Every `.defer()` the route can reach, resolved once at build time and
   * in pre-order. Each step carries the {@link DeferSite} naming its
   * address and its continuation, which is what a resume addresses: the
   * continuation cannot be a closure captured at defer time, because
   * execution two happens in a different process.
   *
   * Absent (rather than empty) on a route that never defers, so the
   * common case costs nothing and `context.start()` can tell "no defers"
   * from "defers, needs a runtime" without walking anything.
   *
   * @internal
   */
  deferSteps?: DeferrableStep[];

  /**
   * Every defer-capable `.to()` / `.enrich()` step the route carries on
   * its primary flow, each holding the re-entrant {@link DeferSite} the
   * walk assigned it. Separate from {@link RouteDefinition.deferSteps}
   * deliberately: a capable step only MAY defer at runtime, so it does not
   * make the route require a deferral runtime at startup (`RC5052` stays
   * keyed to static sites; a runtime deferral without the runtime fails as an
   * ordinary step error naming the config line), and it does not trip the
   * route-scope cache refusal, whose "silently never caches" reasoning
   * assumes every run defers.
   *
   * @internal
   */
  reentrantDeferSteps?: DeferCapableStep[];

  /**
   * The route can reach a `.resume()`. Recorded alongside
   * {@link RouteDefinition.deferSteps} because a resume ingress needs the
   * deferral runtime too (it verifies tokens and reads the store), and a
   * resume-only route carries no defer sites to infer that from.
   *
   * @internal
   */
  usesResume?: boolean;

  /**
   * The route has no `.id()` and a `.cache()` using the default key, which
   * is namespaced by the route id. The generated id changes on every start,
   * so the route warns once it is registered. Set by `RouteBuilder.build()`.
   *
   * @internal
   */
  volatileCacheKey?: boolean;

  /**
   * Fingerprint of the user pipeline a route-scope `.cache()` skips on a
   * hit, folded into its default key (see `CacheKeyScope`). Set by
   * `RouteBuilder.build()` on a route with a route-scope cache.
   *
   * @internal
   */
  cachePipeline?: string;

  /**
   * Where an error-path park would land, per step of this route.
   *
   * Resolved by the same walk that assigns defer sites, for every step
   * rather than only the defer hosts: an error handler sits outside the step
   * tree and has no position of its own, so a park it raises borrows the
   * position of whatever failed, and any step can fail. A step inside a
   * `.split()` fan-out or a sealed side flow carries a refusal instead, so
   * an error-path park is refused from exactly the positions a `DeferSignal`
   * is.
   *
   * Says nothing about whether this route defers. A route with no handler
   * anywhere near it still has the map; what decides is whether a handler
   * ever answers with `recovery.defer()`.
   *
   * @internal
   */
  errorPathSites?: ReadonlyMap<Step<Adapter>, ErrorPathSite>;

  /**
   * Where an error-path park lands when the failure did not come from the
   * step tree at all: the pre-from filter chain, and the framework's own
   * filter positions around the pipeline.
   *
   * @internal
   */
  admissionSite?: DeferSite;
};

/**
 * Represents a runnable route that processes data.
 *
 * Routes handle the flow of data from a source through processing steps
 * and can be started and stopped. Use Route<T> when you know the route's
 * body type (e.g. from a typed definition); at runtime, handlers and
 * events receive Exchange (body: unknown) unless narrowed.
 *
 * @template T The body type of the route's exchange when known (default unknown)
 */
export interface Route<T = unknown> {
  /** The context this route belongs to */
  readonly context: CraftContext;

  /** The route's configuration */
  readonly definition: RouteDefinition<T>;

  /**
   * Fires when in-flight work on this route is being abandoned. NOT fired
   * when the route merely stops accepting new work, which is what graceful
   * shutdown's first stage does.
   */
  readonly signal: AbortSignal;

  /**
   * Fires when the route stops accepting new work, which is the moment
   * graceful shutdown begins. Work already in flight keeps running.
   *
   * A wrapper that is WAITING observes this: a `.delay()` wait, a
   * `.throttle()` pacing gap, a bulkhead queue slot, a `.retry()` backoff.
   * The wait is cut short once shutdown begins and the exchange still
   * reaches a terminal outcome, where sitting the timer out burns the
   * shutdown deadline and ends in an abandonment that reports nothing.
   * {@link Route.signal} is for abandonment itself, never for shortening a
   * wait.
   */
  readonly intakeSignal: AbortSignal;

  /**
   * Abandon in-flight execution on this route. The forced stage of shutdown
   * and an explicit `stop()`; never the graceful drain.
   * @internal
   */
  abortExecution(reason?: unknown): void;

  /**
   * How much work is still in flight. Read when a forced shutdown reports
   * what it is abandoning, which is the only forensic record that stage
   * leaves.
   * @internal
   */
  readonly inFlightCount: number;

  /** Logger for this route (pino child logger) */
  logger: ReturnType<typeof logger.child>;

  /**
   * Start processing: subscribe to every source and begin delivering messages through the steps.
   * @returns Promise that resolves when all sources have been subscribed and the consumers are ready
   */
  start(): Promise<void>;

  /**
   * Fill the route's positions and check its plugin steps are installed.
   *
   * @throws RC1111 naming what is missing
   * @internal
   */
  compile(): void;

  /**
   * Stop the route: abort all source subscriptions and clear the internal queues.
   */
  stop(): void;

  /**
   * Re-arm a stopped route so {@link Route.start} can run again, under the
   * fresh controller the context now holds for it.
   *
   * Only enablement calls this. Both abort controllers latch, and the queues
   * and consumers behind them belong to the run that just ended, so a route
   * brought back from `disabled` needs new ones or it would refuse to start
   * against its own aborted signal. Route IDENTITY is deliberately preserved:
   * ops tracks by route id, the capability registry keys by endpoint, and
   * listeners hold this instance, so re-enabling must not hand out a
   * different object.
   *
   * @param controller - The intake controller the context has registered
   *   for this route, so the two never disagree about which one a shutdown
   *   aborts.
   * @internal
   */
  resetForRestart(controller: AbortController): void;

  /**
   * Wait until all in-flight message handlers and tracked tasks (e.g. tap) have completed.
   * Does not stop the route; use stop() to abort the sources.
   */
  drain(): Promise<void>;

  /**
   * Track a background task (e.g. tap) for this route.
   * @param promise The promise to track
   * @internal
   */
  trackTask(promise: Promise<unknown>): void;

  /**
   * Register a callback run at the START of every `drain()` (which shutdown
   * also calls), before the in-flight wait loop. Lets a step holding an
   * exchange outside the queue (debounce) flush it into in-flight work so
   * drain releases it promptly instead of waiting out a timer. Callbacks
   * must be idempotent: `drain()` can be called more than once.
   *
   * @internal
   */
  onDrain(callback: () => void): void;

  /**
   * Run `steps` against a revived exchange as a first-class run of this
   * route: its own `route:exchange:started` / `:completed` pair, the route-scope
   * `.error()` handler, and `.output()` validation before completion.
   *
   * The entry point for execution two. The steps handed in are the deferred
   * exchange's continuation, so the route resumes partway down its pipeline
   * without re-running what already ran, and without re-running the
   * pre-from filter chain (authorize, parse, input, throttle, cache), all
   * of which belong to execution one.
   *
   * An ADMISSION continuation is the exception, and the only one. It comes
   * from an exchange parked before the route admitted it, so execution one
   * never finished the chain: `.authorize()` and `.input()` run here
   * instead. The source's parse does not, which is why such a park is
   * refused while a source parser is pending rather than resumed against a
   * body nothing parsed.
   *
   * @param exchange - The rehydrated exchange, already bound to this route
   * @param steps - The continuation, in execution order
   * @param kind - Which re-entry this is, which selects the chain policy.
   *   Defaults to `"resume"`; `"admission"` is the park-before-admission case.
   * @internal
   */
  runContinuation(
    exchange: Exchange,
    steps: ReadonlyArray<Step<Adapter>>,
    kind?: DetachedKind,
  ): Promise<DetachedResult>;

  /**
   * Push an error into this route's error channel for an exchange that is
   * not currently running in it.
   *
   * The resume path uses it so a revival failure (an expired deferral, a
   * continuation that changed under a deferred exchange) reaches the
   * DEFERRED route's `.error()` handler rather than only the ingress
   * route's. That is the difference between a route that can notify the
   * approver and re-ask, and an approver left at a dead link.
   *
   * @param exchange - The exchange the failure concerns
   * @param error - The failure to route
   * @param operation - Step label reported on the error events
   * @internal
   */
  enterErrorChannel(
    exchange: Exchange,
    error: unknown,
    operation: string,
  ): Promise<void>;

  /**
   * Build a forward function the route uses to delegate from an
   * error / fallback handler to another route via the direct adapter.
   * Exposed so step-scope `WrapperStep` subclasses can hand the same
   * callable to a user-supplied handler as the route-level pipeline
   * does.
   *
   * @param caller The exchange the forward is issued from. Its headers
   *   travel with the forwarded call, so the target sees the same
   *   principal and correlation id as the caller. Required rather than
   *   optional so a new call site cannot silently forward anonymously.
   * @internal
   */
  getForward(caller: Exchange): ForwardFn;
}

/**
 * Default implementation of the Route interface.
 *
 * Manages message flow from the source through the defined steps and the
 * internal processing queue to the consumer. Handles start, stop, drain, and
 * background task tracking (e.g. for tap).
 */
export class DefaultRoute implements Route {
  /**
   * Stops INTAKE: sources subscribe against this, and aborting it means
   * "produce nothing further". It does NOT cancel work already in flight,
   * which is what makes graceful shutdown's first stage a drain rather than
   * a cancellation.
   */
  private abortController: AbortController;

  /**
   * Abandons EXECUTION: surfaced as {@link DefaultRoute.signal} and threaded
   * into steps, wrappers and agent dispatch. Aborted only when work is
   * genuinely being given up on: a forced shutdown, an explicit `stop()`, or
   * a route that failed to start.
   *
   * Separate from intake because one controller carrying both meanings made
   * the documented two-stage shutdown a lie: the first signal, which
   * promises to stop accepting work and drain, cancelled every in-flight
   * exchange as well.
   */
  private executionController = new AbortController();

  /** Logger for this route (pino child logger) */
  public readonly logger: ReturnType<typeof logger.child>;

  /** Internal queues, one per source, for passing messages to the consumers */
  private messageChannels!: ProcessingQueue<Message>[];

  /** Processes messages from the message channels, one consumer per source */
  private consumers!: Consumer[];

  /** All in-flight work (handler and task promises) for drain */
  private inFlight = new Set<Promise<unknown>>();

  /** Callbacks run at the start of drain() to flush deferred holds (debounce). */
  private drainCallbacks = new Set<() => void>();

  /**
   * Create a new route instance.
   *
   * @param context The context this route belongs to
   * @param definition The route's configuration
   * @param abortController Optional controller for aborting the route
   */
  constructor(
    public readonly context: CraftContext,
    public readonly definition: RouteDefinition,
    abortController?: AbortController,
  ) {
    setBrand(this, BRAND.DefaultRoute);
    this.assertNotAborted();
    this.abortController = abortController ?? new AbortController();
    this.logger = logger.child(childBindings(this));
    if (definition.volatileCacheKey) {
      this.logger.warn(
        { route: definition.id },
        `Route "${definition.id}" has no .id() and uses .cache() with the default key, which includes the route id. ` +
          `The id is generated on every start, so cached entries never match after a restart. Add .id() to the route.`,
      );
    }
    this.buildChannelsAndConsumers();

    this.watchIntakeAbort();
  }

  /**
   * Emit `route:stopping` / `route:stopped` when the intake controller
   * aborts, however that abort arrives (shutdown, `stop()`, a finite source
   * completing). Re-armed on every restart because the listener belongs to
   * the controller, and a restart installs a new one.
   */
  private watchIntakeAbort(): void {
    this.abortController.signal.addEventListener("abort", (event) => {
      try {
        this.context.emit("route:stopping", {
          routeId: this.definition.id,
          route: this,
          reason: (event as unknown as { reason?: unknown })?.reason,
        });
      } finally {
        this.context.emit("route:stopped", {
          routeId: this.definition.id,
          route: this,
        });
      }
    });
  }

  /** @inheritDoc */
  get intakeSignal(): AbortSignal {
    return this.abortController.signal;
  }

  /** @inheritDoc */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * The EXECUTION signal: fires when in-flight work is being abandoned, not
   * when the route merely stops accepting new work. Steps, resilience
   * wrappers and agent dispatch observe this.
   */
  get signal(): AbortSignal {
    return this.executionController.signal;
  }

  /**
   * Abandon in-flight execution on this route.
   *
   * Graceful shutdown never calls this: stage one aborts intake and waits.
   * It is the forced stage, an explicit `stop()`, and a route that failed to
   * start.
   *
   * @param reason - Recorded as the abort reason for anything observing it.
   * @internal
   */
  abortExecution(reason?: unknown): void {
    if (!this.executionController.signal.aborted) {
      this.executionController.abort(reason);
    }
  }

  /**
   * Create a new exchange object from a message and optional headers.
   *
   * Sources that authenticate at their boundary set the structured
   * `Principal` on `headers["routecraft.auth.principal"]` before calling
   * the consumer handler; that value flows through this method as a
   * normal header and surfaces on the exchange via the `ex.principal`
   * getter.
   *
   * This is the single route-ingress boundary: both the consumer handler
   * and `buildForward` funnel through it, and a `direct()` source hands the
   * target its caller's headers verbatim. Engine-owned identity is
   * therefore re-established here rather than inherited:
   *
   * - `routecraft.id` is minted fresh. Ingress is always a new exchange,
   *   and an inherited id collides in every store keyed by it (telemetry
   *   spans and rows, deferral ids). The correlation id is what links a
   *   hop, not the exchange id.
   * - `routecraft.split_hierarchy` is dropped. A split group only joins
   *   within the executor run that created it, so an inherited hierarchy is
   *   unjoinable, and `.aggregate()` would resolve its trailing group id
   *   against the context-wide split-parent store and delete the caller's
   *   still-in-flight entry.
   * - The deferral headers are dropped too; see {@link PER_EXCHANGE_HEADERS}.
   * - `routecraft.route` and `routecraft.operation` are stamped for the
   *   receiving route.
   *
   * Everything else, principal and correlation id included, is inherited by
   * reference; a source with no correlation id to forward gets a fresh one.
   * See `.standards/security.md` section 3.
   *
   * @param message The message data
   * @param headers Optional headers to include
   * @returns A new Exchange object
   * @private
   */
  private buildExchange(message: unknown, headers?: ExchangeHeaders): Exchange {
    const incomingCorrelationId = headers?.[HeadersKeys.CORRELATION_ID] as
      string | undefined;
    // Omitted, not deleted: `delete` drops the header bag into dictionary mode.
    const incoming = (headers ?? {}) as Record<string, unknown>;
    const inherited: Record<string, unknown> = {};
    for (const key of Object.keys(incoming)) {
      if (!PER_EXCHANGE_HEADERS.has(key)) inherited[key] = incoming[key];
    }
    const builtHeaders: Record<string, unknown> = {
      ...inherited,
      [HeadersKeys.ID]: randomUUID(),
      [HeadersKeys.CORRELATION_ID]: incomingCorrelationId ?? randomUUID(),
      [HeadersKeys.ROUTE_ID]: this.definition.id,
      [HeadersKeys.OPERATION]: OperationType.FROM,
    };
    const exchange = new DefaultExchange(this.context, {
      body: message,
      headers: builtHeaders,
    });

    // Add route to internals so steps like tap can access it (symbol-key for cross-instance)
    const internals =
      (
        exchange as unknown as Exchange & {
          [key: symbol]: { context: CraftContext; route?: Route };
        }
      )[INTERNALS_KEY] ?? EXCHANGE_INTERNALS.get(exchange);
    if (internals) {
      internals.route = this;
    }

    return exchange;
  }

  private cachedExecutorDeps?: ExecutorDeps;
  private cachedValidationDeps?: ValidationDeps;

  /**
   * Assemble the deps object for the pipeline executor. Memoized: every
   * field is stable for the lifetime of the route, and this is called on
   * the per-exchange hot path.
   */
  private executorDeps(): ExecutorDeps {
    if (!this.cachedExecutorDeps) {
      const slots = this.slots();
      this.cachedExecutorDeps = {
        routeId: this.definition.id,
        context: this.context,
        route: this,
        definition: this.definition,
        buildForward: (caller: Exchange) => this.buildForward(caller),
        positions: this.positions(),
        ...(slots ? { slots } : {}),
      };
    }
    return this.cachedExecutorDeps;
  }

  private compiledPositions?: CompiledPositions;

  /**
   * Fill this route's positions from its application's providers and check
   * that every plugin step it uses is installed. The context runs it for
   * every route before any starts, so a missing provider fails the
   * application's start instead of one route on its first exchange.
   *
   * @throws RC1111 naming what is missing
   * @internal
   */
  compile(): void {
    this.positions();
    this.assertStepPlugins();
    this.assertStepPositions();
  }

  /**
   * Every step-scope wrapper in the route, branches and wrapper stacks
   * included, has a provider for the port it resolves at run time. The
   * position itself stays unbuilt until an exchange reaches the wrapper
   * (see `WrapperStep.requiredPosition`); only the provider is checked here.
   *
   * @throws RC1111 naming the method and the missing port
   */
  private assertStepPositions(): void {
    // By shape rather than instanceof: a wrapper from the package's other
    // build (ESM beside CJS) is a different class with the same protocol.
    const wrappedOf = (step: Step<Adapter>): Step<Adapter> | undefined => {
      const inner = (step as Partial<WrapperStep>).wrapped;
      return typeof inner === "object" && inner !== null ? inner : undefined;
    };
    const walk = (steps: ReadonlyArray<Step<Adapter>>): void => {
      for (const step of steps) {
        const seen = new Set<Step<Adapter>>();
        for (
          let wrapper: Step<Adapter> | undefined = step;
          wrapper !== undefined && !seen.has(wrapper);
          wrapper = wrappedOf(wrapper)
        ) {
          seen.add(wrapper);
          const required = (wrapper as Partial<WrapperStep>).requiredPosition;
          if (required && this.context.lookup(required.port) === undefined) {
            const label = wrapper.label ?? String(wrapper.operation);
            throw rcError("RC1111", undefined, {
              message: `Route "${this.definition.id}" uses .${required.method}() on step "${label}", and no installed plugin provides "${required.port.name}". Install a plugin that provides it, or remove .${required.method}() from the route.`,
            });
          }
        }
        for (const nested of nestedStepsOf(step)) walk(nested.steps);
      }
    };
    walk(this.definition.steps);
  }

  /**
   * Every plugin step in the route, branches included, comes from a plugin
   * this application installs.
   *
   * @throws RC1111 naming the missing plugins
   */
  private assertStepPlugins(): void {
    const missing = new Set<string>();
    const walk = (steps: ReadonlyArray<Step<Adapter>>): void => {
      for (const step of steps) {
        const plugin = (step as { [STEP_PLUGIN]?: string })[STEP_PLUGIN];
        if (plugin !== undefined && !this.context.hasPlugin(plugin)) {
          missing.add(plugin);
        }
        for (const nested of nestedStepsOf(step)) walk(nested.steps);
      }
    };
    walk(this.definition.steps);
    if (missing.size > 0) {
      const ids = [...missing].map((id) => `"${id}"`).join(", ");
      throw rcError("RC1111", undefined, {
        message: `Route "${this.definition.id}" uses steps of ${ids}, which this application does not install. Install the plugin, or build the route with the project's craft() so the step is a compile error instead.`,
      });
    }
  }

  /**
   * This route's positions, filled once by its application's providers.
   *
   * @throws RC1111 when a configured position has no provider
   */
  private positions(): CompiledPositions {
    this.compiledPositions ??= compilePositions(this.definition, this.context);
    return this.compiledPositions;
  }

  /**
   * The plugin hooks that apply to this route, placed once. Absent before
   * the application froze and when no plugin hooks this route.
   */
  private slots(): RouteSlots | undefined {
    const table = this.context.hooks;
    if (!table) return undefined;
    const id = this.definition.id;
    const tags = routeTags(this.definition);
    const beforeAuth = buildSlotStep(table, "beforeAuth", id, tags);
    const afterAuth = buildSlotStep(table, "afterAuth", id, tags);
    const admitted = buildSlotStep(table, "admitted", id, tags);
    const perAttempt = table.forRoute("perAttempt", id, tags);
    if (!beforeAuth && !afterAuth && !admitted && perAttempt.length === 0) {
      return undefined;
    }
    return {
      ...(beforeAuth ? { beforeAuth } : {}),
      ...(afterAuth ? { afterAuth } : {}),
      ...(admitted ? { admitted } : {}),
      perAttempt,
      tags,
    };
  }

  /** Assemble the deps object for the pipeline validation helpers (memoized, see {@link executorDeps}). */
  private validationDeps(): ValidationDeps {
    if (!this.cachedValidationDeps) {
      const deps: ValidationDeps = {
        routeId: this.definition.id,
        context: this.context,
        route: this,
        buildForward: (caller: Exchange) => this.buildForward(caller),
      };
      if (this.definition.errorHandler) {
        deps.errorHandler = this.definition.errorHandler;
      }
      this.cachedValidationDeps = deps;
    }
    return this.cachedValidationDeps;
  }

  /**
   * Track a background task (e.g. tap) for this route.
   * @internal
   */
  trackTask(promise: Promise<unknown>): void {
    const handledPromise = promise.catch((err: unknown) => {
      const msg = isRoutecraftError(err)
        ? (err as { meta: { message: string } }).meta.message
        : err instanceof Error
          ? err.message
          : "Background task failed";
      this.logger.error({ err, route: this.definition.id }, msg);
    });
    this.inFlight.add(handledPromise);
    handledPromise.finally(() => this.inFlight.delete(handledPromise));
  }

  /**
   * Register a flush callback run at the start of drain(). See {@link Route.onDrain}.
   * @internal
   */
  onDrain(callback: () => void): void {
    this.drainCallbacks.add(callback);
  }

  /**
   * Start processing data on this route.
   *
   * This method:
   * 1. Registers each per-source consumer to process messages
   * 2. Subscribes to every source to receive data
   *
   * `route:started` fires once, when every source has signalled readiness;
   * a source that emits without calling `ready()` is marked ready by its
   * first message. `start()` resolves only when every subscription resolves,
   * so a server ingress (direct, http, mcp) keeps the context alive while a
   * route of finite sources completes and lets it auto-stop.
   *
   * A source that fails to subscribe, synchronously or not, aborts the whole
   * route so siblings that already subscribed are torn down, and fires
   * `route:source:failed` first so operators see which ingress died. A
   * rejection after the source's own controller aborted is teardown noise
   * and fires nothing. When every ingress of a multi-source route has
   * completed, the route aborts its own intake, mirroring a single finite
   * source; in-flight exchanges still drain.
   *
   * @returns A promise that resolves when the route has started
   * @throws {RoutecraftError} If the route has been aborted
   */
  async start(): Promise<void> {
    this.assertNotAborted();
    this.compile();
    // Lifecycle log is emitted only by context (one log per event).

    const consumerHandler = this.buildConsumerHandler();
    for (const consumer of this.consumers) {
      consumer.register(consumerHandler);
    }

    const total = this.definition.sources.length;
    const readyIndices = new Set<number>();
    let startedEmitted = false;
    const markReady = (index: number): void => {
      readyIndices.add(index);
      if (!startedEmitted && readyIndices.size === total) {
        startedEmitted = true;
        this.context.emit("route:started", {
          routeId: this.definition.id,
          route: this,
        });
      }
    };

    const meta = {
      routeId: this.definition.id,
      ...(this.definition.discovery
        ? { discovery: this.definition.discovery }
        : {}),
      ...(this.definition.requiresPrincipal ? { requiresPrincipal: true } : {}),
      ...(this.definition.consumer.type.buffers === true
        ? { bufferedConsumer: true }
        : {}),
    };

    // Built inside the try so a synchronous wiring throw takes the same cleanup path.
    try {
      const subscriptions = this.definition.sources.map(
        (definitionSource, index) => {
          const channel = this.messageChannels[index];
          const sourceOverride = resolveAdapterOverride(
            definitionSource,
            this.context,
            "source",
          );
          const activeSource =
            sourceOverride && sourceOverride.source
              ? wrapSourceWithOverride(definitionSource, sourceOverride)
              : definitionSource;
          // One source shares the route's controller, so its completion stops the route.
          const sourceController =
            total === 1 ? this.abortController : this.linkedChildController();
          // Capabilities are added as new fields, never as positional parameters.
          const subscription: Subscription = {
            context: this.context,
            signal: sourceController.signal,
            meta,
            ready: () => markReady(index),
            complete: (reason?: unknown) => sourceController.abort(reason),
            emit: (msg) => {
              markReady(index); // fallback: fire before first message if adapter never called ready()
              return channel.enqueue({
                message: msg.message,
                headers: msg.headers ?? {},
                ...(msg.parse
                  ? {
                      parse: msg.parse,
                      parseFailureMode: msg.parseFailureMode ?? "fail",
                    }
                  : {}),
              });
            },
          };
          return Promise.resolve(activeSource.subscribe(subscription)).catch(
            (error: unknown) => {
              if (!sourceController.signal.aborted) {
                this.context.emit("route:source:failed", {
                  routeId: this.definition.id,
                  route: this,
                  ...(activeSource.adapterId
                    ? { adapter: activeSource.adapterId }
                    : {}),
                  error,
                });
              }
              throw error;
            },
          );
        },
      );
      await Promise.all(subscriptions);
    } catch (err) {
      // A source that could not subscribe is a failure, not a completion, so
      // in-flight work on this route is abandoned along with intake.
      if (!this.abortController.signal.aborted) {
        this.abortController.abort(err);
      }
      this.abortExecution(err);
      throw err;
    }

    // Intake only: a server ingress never resolves un-aborted, so this is a no-op there.
    if (total > 1 && !this.abortController.signal.aborted) {
      this.abortController.abort("All ingresses completed");
    }
  }

  /**
   * Create an AbortController that aborts when the route's controller aborts,
   * but whose own abort does not propagate back to the route. Used to give
   * each ingress of a multi-source route an independent lifetime so a finite
   * source completing does not tear down its sibling ingresses.
   */
  private linkedChildController(): AbortController {
    const child = new AbortController();
    if (this.abortController.signal.aborted) {
      child.abort(this.abortController.signal.reason);
    } else {
      this.abortController.signal.addEventListener(
        "abort",
        () => child.abort(this.abortController.signal.reason),
        { once: true },
      );
    }
    return child;
  }

  /**
   * Build the handler registered on every per-source consumer. The handler is
   * shared across all of a route's ingresses so they drive one pipeline; it
   * stashes the source-supplied parser and the route's `.input()` validator
   * on exchange internals so `runPipeline` runs both INSIDE the pre-from
   * filter chain (positions #3 / #4). A parse or validation failure is
   * therefore a normal step failure, routable through the route-scope
   * `.error()` handler (chain position #1) for every source shape; see
   * #187 (parse) and #447 (the input fold).
   */
  private buildConsumerHandler(): (envelope: Message) => Promise<Exchange> {
    return async ({ message, headers, parse, parseFailureMode }) => {
      const exchange = this.buildExchange(message, headers);

      const internals = EXCHANGE_INTERNALS.get(exchange);
      if (internals && parse) {
        internals.parse = parse;
        internals.parseFailureMode = parseFailureMode ?? "fail";
      }
      this.attachInputValidation(exchange);

      return this.handler(exchange);
    };
  }

  /**
   * Stash this route's `.input()` validator on an exchange, so `runPipeline`
   * runs it at chain position #4.
   *
   * Two callers, and the second is why it is a method. An arriving exchange
   * gets it from the consumer handler; a rehydrated one parked before
   * admission gets it here, because the closure cannot cross the store and
   * has to be rebuilt from the route's own schemas. Building it twice would
   * be two chances to validate a different thing.
   *
   * No-op on a route that declares no input schemas.
   */
  private attachInputValidation(exchange: Exchange): void {
    const inputSchemas = this.definition.discovery?.input;
    if (!inputSchemas?.body && !inputSchemas?.headers) return;
    const internals = EXCHANGE_INTERNALS.get(exchange);
    if (!internals) return;
    // Non-emitting: the step loop owns the events, so none are duplicated.
    internals.applyValidation = (ex: Exchange) =>
      validateInputOrThrow(this.validationDeps(), ex, inputSchemas);
  }

  /**
   * Stop processing data on this route.
   *
   * This method:
   * 1. Unsubscribes from the internal processing queue
   * 2. Aborts the route's controller
   */
  stop(): void {
    // Lifecycle log is emitted only by context (one log per event).
    for (const channel of this.messageChannels) {
      channel.clear();
    }
    // Both signals: stop() discards queued messages, so it is a giving-up on
    // this route rather than the orderly drain graceful shutdown performs.
    this.abortController.abort("Route stop() called");
    this.abortExecution("Route stop() called");
  }

  /**
   * One (channel, consumer) pair per source, so each ingress gets its own
   * delivery queue and, for batch routes, its own batch window. All
   * consumers drive the same shared step pipeline via the handler registered
   * in start(), so the route stays a single logical entity regardless of how
   * many ingresses it exposes.
   *
   * Shared by the constructor and the restart so a consumer that gains a
   * construction dependency cannot get it in one path and silently miss it
   * in the other.
   */
  private buildChannelsAndConsumers(): void {
    this.messageChannels = this.definition.sources.map(
      () => new InMemoryProcessingQueue<Message>(),
    );
    this.consumers = this.messageChannels.map(
      (channel) =>
        new this.definition.consumer.type({
          context: this.context,
          definition: this.definition,
          channel,
          options: this.definition.consumer.options,
        }),
    );
  }

  /** @inheritDoc */
  resetForRestart(controller: AbortController): void {
    this.abortController = controller;
    this.executionController = new AbortController();
    // Rebuilt, not reused: a consumer may hold per-run state (a batch window, a debounce hold).
    this.buildChannelsAndConsumers();
    this.watchIntakeAbort();
  }

  /**
   * Process an exchange through the route's steps.
   * Resolves with the result immediately; then waits for background tasks (e.g. tap) before cleanup.
   *
   * Output validation runs only on a completed exchange, and a failure there
   * takes the same path as a thrown step. A deferred exchange skips both the
   * output stage and completion: its body is the `Deferred` acknowledgment,
   * not the route's output, and its terminal event was
   * `route:exchange:deferred`. The source still receives it, which is how
   * each transport renders the acknowledgment.
   *
   * @param exchange The initial exchange to process
   * @returns A promise that resolves when processing is complete
   * @private
   */
  private handler(exchange: Exchange): Promise<Exchange> {
    exchange.logger.debug({ operation: "from" }, "Processing initial exchange");

    const startTime = Date.now();

    // Emit route:exchange:started event
    const correlationId = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;
    this.context.emit("route:exchange:started", {
      routeId: this.definition.id,
      exchangeId: exchange.id,
      correlationId,
    });

    // Run steps (tap adds tasks via route.trackTask)
    const handlerPromise = runPipeline(
      this.executorDeps(),
      exchange,
      startTime,
    ).then(async (piped) => {
      const result = await applyExitSlot(this.executorDeps(), piped, "normal");
      const finalResult = await applyOutputStage(
        this.validationDeps(),
        this.definition.discovery?.output,
        result,
        startTime,
      );

      if (
        !finalResult.failed &&
        !finalResult.dropped &&
        !finalResult.deferred
      ) {
        const duration = Date.now() - startTime;
        const correlationId = exchange.headers[
          HeadersKeys.CORRELATION_ID
        ] as string;
        this.context.emit("route:exchange:completed", {
          routeId: this.definition.id,
          exchangeId: exchange.id,
          correlationId,
          duration,
          exchange: finalResult.exchange,
        });
      }

      // Reject so callers (CraftClient, direct channel) can handle the error.
      // Source adapters catch this rejection and continue processing.
      if (finalResult.failed && finalResult.error) {
        throw finalResult.error;
      }

      return finalResult.exchange;
    });

    // Catch-suppressed copy: the caller handles the real rejection.
    const tracked = handlerPromise.catch(() => {});
    this.inFlight.add(tracked);
    tracked.finally(() => this.inFlight.delete(tracked));

    return handlerPromise;
  }

  /**
   * Run a revived exchange through its continuation. See
   * {@link Route.runContinuation}.
   *
   * Tracked as in-flight work so `drain()` (and therefore shutdown) waits
   * for execution two, which arrives out of band and would otherwise be
   * invisible to the route that owns it.
   *
   * An admission run re-attaches the `.input()` validator from the live
   * route's schemas, since the closure cannot cross the store. A source
   * parser cannot be rebuilt this way, which is why a park above a pending
   * one is refused at park time.
   *
   * @internal
   */
  runContinuation(
    exchange: Exchange,
    steps: ReadonlyArray<Step<Adapter>>,
    kind: DetachedKind = "resume",
  ): Promise<DetachedResult> {
    if (kind === "admission") this.attachInputValidation(exchange);
    const run = runDetachedPipeline(this.executorDeps(), steps, exchange, kind);
    this.trackTask(run);
    return run;
  }

  /**
   * Push an error into this route's error channel. See
   * {@link Route.enterErrorChannel}.
   *
   * Implemented as a one-step pipeline whose step throws, rather than by
   * calling the handler directly, so a revival failure produces exactly the
   * events a step failure produces (`route:step:error`,
   * `route:error-handler:invoked` / `:recovered` / `:failed`, or the
   * default `route:error` + `context:error` + `route:exchange:failed`
   * path). A second, hand-rolled error path would drift from that one.
   *
   * The re-entry is a run of this route in its own right, with its own
   * started / terminal pair. `.output()` validation is not applied to a
   * recovered body: a re-ask handler returns a notification, not the
   * route's output. The handler forwards as the deferred exchange, whose
   * principal came back from the store marked restored, so a target
   * declaring `.authorize()` refuses it (RC5043): nothing re-verified that
   * identity across the deferral. The step's adapter id derives from the
   * caller's `operation`, so a sweeper or deny path is not attributed to
   * resume in telemetry.
   *
   * @internal
   */
  async enterErrorChannel(
    exchange: Exchange,
    error: unknown,
    operation: string,
  ): Promise<void> {
    const start = Date.now();
    const correlationId = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;
    this.context.emit("route:exchange:started", {
      routeId: this.definition.id,
      exchangeId: exchange.id,
      correlationId,
    });
    const routeDeps: ExecutorDeps = { ...this.executorDeps() };
    delete routeDeps.slots;
    const slots = detachedSlots(routeDeps);
    const deps: ExecutorDeps = {
      ...routeDeps,
      ...(slots ? { slots } : {}),
      runKind: "errorChannel",
      definition: detachedDefinition(
        this.definition,
        [
          {
            operation: OperationType.PROCESS,
            label: operation,
            adapter: { adapterId: `routecraft.operation.${operation}` },
            execute: () => Promise.reject(error),
          },
        ],
        "errorChannel",
      ),
    };
    const result = await runPipeline(deps, exchange, start);
    if (!result.failed && !result.dropped) {
      this.context.emit("route:exchange:completed", {
        routeId: this.definition.id,
        exchangeId: exchange.id,
        correlationId,
        duration: Date.now() - start,
        exchange: result.exchange,
      });
    }
  }

  /**
   * Build a forward function that sends a payload to another route via the direct adapter.
   *
   * Exposed (`@internal`) so step-scope `WrapperStep` subclasses can hand
   * the same forward callable to a user-supplied error / fallback handler
   * as the route-level pipeline does. Resolve via
   * `getExchangeRoute(exchange).getForward(exchange)`.
   *
   * @returns A forward function
   */
  getForward(caller: Exchange): ForwardFn {
    return this.buildForward(caller);
  }

  /**
   * Build a forward function that sends a payload to another route via the direct adapter.
   *
   * The forwarded exchange inherits the calling exchange's headers, which is
   * what carries the caller's principal and correlation id across the hop. A
   * `direct()` destination gets this for free because it hands the target its
   * live exchange; forward builds a fresh envelope, so it has to pass the
   * headers explicitly or the target sees an anonymous, separately-traced
   * call.
   *
   * @param caller The exchange the forward is issued from
   * @returns A forward function
   * @private
   */
  private buildForward(caller: Exchange): ForwardFn {
    return async (
      endpoint: RegisteredDirectEndpoint,
      payload: unknown,
    ): Promise<unknown> => {
      const forwardExchange = this.buildExchange(payload, caller.headers);
      const result = await this.context
        .require(DIRECT)
        .send(endpoint as string, forwardExchange);
      // Mirror CraftClient.sendDirect: a dropped exchange has no result,
      // and resolving with its body would echo the forwarded payload back
      // as if the target route produced it.
      if (isDropped(result)) {
        throw rcError("RC5031", undefined, {
          message: `Forward target "${String(endpoint)}" dropped the exchange instead of completing it; there is no result body.`,
        });
      }
      return result.body;
    };
  }

  /**
   * Wait for all in-flight work (handlers and tasks) to complete.
   * Loops until no new work is added (drains consumer queue).
   */
  async drain(): Promise<void> {
    // Flush any deferred holds (e.g. debounce) FIRST so their releases become
    // tracked in-flight work before we wait, rather than waiting out a timer.
    this.runDrainCallbacks();
    this.logger.debug(
      { inFlight: this.inFlight.size },
      "Draining route: waiting for in-flight handlers and tasks",
    );
    while (this.inFlight.size > 0) {
      const current = [...this.inFlight];
      await Promise.allSettled(current);
      // Re-flush after each settle round: a flushed release can create a NEW
      // hold further down the pipeline (e.g. chained debounce steps), which
      // would otherwise sit out its full timer before the loop could finish.
      this.runDrainCallbacks();
    }
    this.logger.debug({}, "Route drained");
  }

  /**
   * Run the registered drain-flush callbacks (see {@link Route.onDrain}).
   * Callbacks are idempotent by contract, so calling this repeatedly (once
   * up front and once per drain settle round) is safe.
   */
  private runDrainCallbacks(): void {
    for (const callback of this.drainCallbacks) {
      try {
        callback();
      } catch (err) {
        this.logger.error(
          { err, route: this.definition.id },
          "drain flush callback failed",
        );
      }
    }
  }

  /**
   * Check if the route has been aborted, and throw an error if it has.
   *
   * @throws {RoutecraftError} If the route has been aborted
   * @private
   */
  private assertNotAborted(): void {
    if (this.abortController?.signal.aborted) {
      throw rcError("RC3001", undefined, {
        message: `${RC["RC3001"].message}: ${this.definition.id}`,
      });
    }
  }
}
