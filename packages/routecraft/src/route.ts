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
import type { CircuitBreakerController } from "./operations/circuit-breaker-wrapper.ts";
import type { ConcurrencyController } from "./operations/concurrency-wrapper.ts";
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
  runDetachedPipeline,
  runPipeline,
  type DetachedResult,
  type ExecutorDeps,
} from "./pipeline/executor.ts";
import { detachedDefinition } from "./pipeline/chain-policy.ts";
import type {
  SuspendCapableStep,
  SuspendableStep,
} from "./suspension/sites.ts";

// Re-exported for existing imports (builder.ts and @internal consumers).
export { buildCacheCheckStep, buildCacheStoreStep, buildThrottleCheckStep };

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
 * `route:exchange:dropped`, no `exchange:completed`), and
 * `recovery.rethrow()` propagates the original error exactly as if the
 * handler had thrown it. Plain (unbranded) return values are unaffected.
 *
 * @param error - The thrown error
 * @param exchange - The exchange at the point of failure
 * @param forward - Sends a payload to another route via the direct adapter
 * @returns Static fallback value, result of forward(), or a `Recovery` directive
 */
export type ErrorHandler = (
  error: unknown,
  exchange: Exchange,
  forward: ForwardFn,
) => unknown | Promise<unknown>;

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
   * Framework-managed filters that run BEFORE the source-attached
   * parse step (and therefore before everything else). Today: the
   * `.authorize()` ValidateSteps in declaration order. This is chain
   * position #2 in `.standards/pre-from-filter-chain.md`.
   *
   * @internal
   */
  readonly preParseFilters: Step<Adapter>[];

  /**
   * Framework-managed filters that run AFTER the source-attached parse
   * step but BEFORE the user pipeline. Today: the route-scope
   * `cache-check` filter (chain position #9). The future
   * `circuitBreaker` (#6) slots in once it lands. Route-scope
   * `throttle` (#5), `retry` (#7), and `timeout` (#8) instead sit
   * OUTSIDE this array (it is wrapped by the retry / timeout segments),
   * so they ride on their own definition fields below.
   *
   * @internal
   */
  readonly postParseFilters: Step<Adapter>[];

  /**
   * Framework-managed filters that run AFTER the user pipeline.
   * Today: the route-scope `cache-store` filter (chain position #10)
   * when `.cache()` is configured. Reached only on miss-success; the
   * cache-check filter pushes `steps: []` on a hit to short-circuit.
   *
   * @internal
   */
  readonly postFromFilters: Step<Adapter>[];

  /**
   * Optional route-level discovery bundle: title, description, and input /
   * output schemas. Populated via `.title()`, `.description()`, `.input()`,
   * and `.output()` on the route builder. The engine enforces `input` and
   * `output` schemas; discovery-aware adapters (direct, mcp) mirror the
   * metadata into their registries.
   */
  readonly discovery?: RouteDiscovery;

  /**
   * True when the route declares a route-entry `.authorize()`. Mirrored to
   * sources via {@link SourceMeta.requiresPrincipal} so identity-capable
   * transports enforce credential verification before dispatching into the
   * route, even on an unwalled mount.
   */
  readonly requiresPrincipal?: boolean;

  /**
   * Route-scope `.retry()` config (pre-from filter chain position #7).
   * Unlike the cache filters, retry is not a flat step in
   * `postParseFilters`: it scopes over the whole chain tail (timeout,
   * cache-check, user pipeline, cache-store) and re-runs it on
   * failure, so the pipeline executor wraps the tail in a retry
   * segment step when this is set. See
   * `.standards/pre-from-filter-chain.md`.
   */
  readonly retry?: ResolvedRetryOptions;

  /**
   * Route-scope `.timeout()` config (pre-from filter chain position
   * #8). Bounds each run of the chain tail below it with a deadline;
   * placed inside `retry` so every attempt gets its own deadline. Like
   * `retry`, realized as a segment step wrapped around the tail by the
   * pipeline executor rather than a flat `postParseFilters` entry.
   */
  readonly timeout?: ResolvedTimeoutOptions;

  /**
   * Route-scope `.throttle()` admission gates (pre-from filter chain
   * position #5), in declaration order. Each is a one-shot gate (a flat
   * step, not a segment like retry / timeout); the exchange must be
   * admitted by ALL of them, so stacking `.throttle()` calls AND-combines
   * independent limits (e.g. a global ceiling plus a per-principal rate).
   * The pipeline executor places them OUTSIDE the retry (#7) / timeout
   * (#8) segments (throttle #5 is above them in the chain) and runs them
   * once per exchange; a retried attempt re-runs only the tail below and
   * never re-acquires a token.
   *
   * @internal
   */
  readonly throttle?: Step<Adapter>[];

  /**
   * Route-scope `.circuitBreaker()` controller (pre-from filter chain
   * position #6). Unlike retry / timeout (config objects re-built into a
   * segment per run), the breaker holds persistent per-Route state (the
   * failure window and the open/half-open machine), so the builder stores
   * the live {@link CircuitBreakerController} here once at `.from()` time
   * and the pipeline executor wraps the chain tail in a breaker segment
   * around it. Sits OUTSIDE the retry (#7) / timeout (#8) segments and
   * INSIDE the throttle (#5) gate: when open it fast-fails before retry /
   * timeout run, so one tripped breaker call is recorded per fully
   * exhausted attempt, not per retry. See
   * `.standards/pre-from-filter-chain.md`.
   *
   * @internal
   */
  readonly circuitBreaker?: CircuitBreakerController;

  /**
   * Route-scope `.concurrency()` bulkhead controllers (one per
   * `.concurrency()` call; they nest). Like the circuit breaker they hold
   * persistent per-Route state (the slot pool / semaphores), so the builder
   * stores the live {@link ConcurrencyController}s here once at `.from()`
   * time and the pipeline executor wraps the chain tail in a bulkhead
   * segment per controller. Sits at the INNERMOST resilience position,
   * INSIDE the retry (#7) / timeout (#8) segments, so a slot is acquired
   * per attempt and released between retry backoffs (never held while a
   * retry sleeps). See `.standards/pre-from-filter-chain.md`.
   *
   * @internal
   */
  readonly concurrency?: ConcurrencyController[];

  /**
   * Every `.suspend()` the route can reach, resolved once at build time and
   * in pre-order. Each step carries the {@link SuspendSite} naming its
   * address and its continuation, which is what a resume addresses: the
   * continuation cannot be a closure captured at suspend time, because
   * execution two happens in a different process.
   *
   * Absent (rather than empty) on a route that never suspends, so the
   * common case costs nothing and `context.start()` can tell "no suspends"
   * from "suspends, needs a runtime" without walking anything.
   *
   * @internal
   */
  suspendSteps?: SuspendableStep[];

  /**
   * Every suspend-capable `.to()` / `.enrich()` step the route carries on
   * its primary flow, each holding the re-entrant {@link SuspendSite} the
   * walk assigned it. Separate from {@link RouteDefinition.suspendSteps}
   * deliberately: a capable step only MAY park at runtime, so it does not
   * make the route require a suspension runtime at startup (`RC5052` stays
   * keyed to static sites; a runtime park without the runtime fails as an
   * ordinary step error naming the config line), and it does not trip the
   * route-scope cache refusal, whose "silently never caches" reasoning
   * assumes every run parks.
   *
   * @internal
   */
  reentrantSuspendSteps?: SuspendCapableStep[];

  /**
   * The route can reach a `.resume()`. Recorded alongside
   * {@link RouteDefinition.suspendSteps} because a resume ingress needs the
   * suspension runtime too (it verifies tokens and reads the store), and a
   * resume-only route carries no suspend sites to infer that from.
   *
   * @internal
   */
  usesResume?: boolean;
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

  /** Signal that indicates when the route has been aborted */
  readonly signal: AbortSignal;

  /** Logger for this route (pino child logger) */
  logger: ReturnType<typeof logger.child>;

  /**
   * Start processing: subscribe to every source and begin delivering messages through the steps.
   * @returns Promise that resolves when all sources have been subscribed and the consumers are ready
   */
  start(): Promise<void>;

  /**
   * Stop the route: abort all source subscriptions and clear the internal queues.
   */
  stop(): void;

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
   * route: its own `exchange:started` / `:completed` pair, the route-scope
   * `.error()` handler, and `.output()` validation before completion.
   *
   * The entry point for execution two. The steps handed in are the parked
   * exchange's continuation, so the route resumes partway down its pipeline
   * without re-running what already ran, and without re-running the
   * pre-from filter chain (authorize, parse, input, throttle, cache), all
   * of which belong to execution one.
   *
   * @param exchange - The rehydrated exchange, already bound to this route
   * @param steps - The continuation, in execution order
   * @internal
   */
  runContinuation(
    exchange: Exchange,
    steps: ReadonlyArray<Step<Adapter>>,
  ): Promise<DetachedResult>;

  /**
   * Push an error into this route's error channel for an exchange that is
   * not currently running in it.
   *
   * The resume path uses it so a revival failure (an expired suspension, a
   * continuation that changed under a parked exchange) reaches the
   * SUSPENDED route's `.error()` handler rather than only the ingress
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
  /** Controls aborting the route's operations */
  private abortController: AbortController;

  /** Logger for this route (pino child logger) */
  public readonly logger: ReturnType<typeof logger.child>;

  /** Internal queues, one per source, for passing messages to the consumers */
  private messageChannels: ProcessingQueue<Message>[];

  /** Processes messages from the message channels, one consumer per source */
  private consumers: Consumer[];

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
    // One (channel, consumer) pair per source so each ingress gets its own
    // delivery queue and, for batch routes, its own batch window. All
    // consumers drive the same shared step pipeline via the handler
    // registered in start(); the route stays a single logical entity (one id,
    // one lifecycle event stream) regardless of how many ingresses it exposes.
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

    // Emit routeStopping/routeStopped when the controller is aborted externally
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

  /**
   * Get the abort signal for this route.
   */
  get signal(): AbortSignal {
    return this.abortController.signal;
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
   *   spans and rows, suspension ids). The correlation id is what links a
   *   hop, not the exchange id.
   * - `routecraft.split_hierarchy` is dropped. A split group only joins
   *   within the executor run that created it, so an inherited hierarchy is
   *   unjoinable, and `.aggregate()` would resolve its trailing group id
   *   against the context-wide split-parent store and delete the caller's
   *   still-in-flight entry.
   * - `routecraft.route` and `routecraft.operation` are stamped for the
   *   receiving route.
   *
   * Everything else, principal and correlation id included, is inherited by
   * reference. See `.standards/security.md` section 3.
   *
   * @param message The message data
   * @param headers Optional headers to include
   * @returns A new Exchange object
   * @private
   */
  private buildExchange(message: unknown, headers?: ExchangeHeaders): Exchange {
    // Preserve the caller's correlation id when the source forwarded one
    // (route-to-route via direct(), MCP tool calls, HTTP requests carrying
    // a trace header). Falls back to a fresh UUID for sources that emit
    // independent exchanges (timer, cron, simple, fresh ingress). This
    // keeps cross-route logs / spans on the same logical request without
    // requiring callers to thread the id manually.
    const incomingCorrelationId = headers?.[HeadersKeys.CORRELATION_ID] as
      string | undefined;
    // Omitted rather than deleted after the fact: `delete` on a fresh literal
    // drops the object into dictionary mode, and this one becomes the header
    // bag every step then reads.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit
    const { [HeadersKeys.SPLIT_HIERARCHY]: _unjoinable, ...inherited } =
      headers ?? {};
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
    this.cachedExecutorDeps ??= {
      routeId: this.definition.id,
      context: this.context,
      route: this,
      definition: this.definition,
      buildForward: (caller: Exchange) => this.buildForward(caller),
    };
    return this.cachedExecutorDeps;
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
   * @returns A promise that resolves when the route has started
   * @throws {RoutecraftError} If the route has been aborted
   */
  async start(): Promise<void> {
    this.assertNotAborted();
    // Lifecycle log is emitted only by context (one log per event).

    // Register the shared pipeline handler on every per-source consumer.
    // Framework-level `.input()` validation is stashed on exchange
    // internals here and runs INSIDE the pre-from filter chain (position
    // #4), so any source adapter with an `.input()` schema on the route
    // inherits validation without per-adapter wiring, and a failure is
    // routable through the route-scope `.error()` handler. Unrecovered,
    // the handler's rejection still reaches the source's own caller
    // (e.g. a direct channel's `send`). See #447.
    const consumerHandler = this.buildConsumerHandler();
    for (const consumer of this.consumers) {
      consumer.register(consumerHandler);
    }

    // Emit `route:started` once ALL sources have signalled readiness. The
    // route is a single logical entity, so its lifecycle events fire once no
    // matter how many ingresses it exposes. Every built-in source calls
    // `onReady`; the enqueue callback also marks readiness as a fallback for
    // callable sources that produce a message without calling it.
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
    };

    // Subscribe every source, each into its own channel. A test-time override
    // is resolved per source so individual ingresses can be mocked. start()
    // resolves only when ALL subscriptions resolve: server ingresses (direct,
    // http, mcp) hold open until abort, so a multi-ingress route with any
    // server ingress keeps the context alive, while a route whose sources are
    // all finite completes and lets the context auto-stop.
    // Build AND await every subscription inside the try so both a synchronous
    // throw while wiring a source (override resolution, a sync callable source)
    // and an async subscribe rejection hit the same cleanup path. On failure,
    // abort the route so any sibling ingresses that already subscribed are torn
    // down (registry entries cleared, pending subscribes resolved) instead of
    // leaking, then surface the error. `context.start()` already aborts on a
    // failed route.start(); this makes start() self-cleaning for direct callers
    // too. Harmless for the single-source case (no siblings).
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
          // A single-source route hands the source the route's own controller
          // so a finite source completing (such sources call abort() when done)
          // stops the route exactly as before. A multi-ingress route gives each
          // source a child controller linked to the route's: the route aborts
          // every child, but one finite ingress completing only aborts its own
          // child and never tears down a sibling ingress (e.g. a long-lived
          // http/mcp server holding the route open).
          const sourceController =
            total === 1 ? this.abortController : this.linkedChildController();
          // Assemble the Subscription object: the single argument every
          // source receives. Capabilities are added here as new fields,
          // never as new positional parameters.
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
          // Coerce to a promise so a void return and an async rejection are
          // handled uniformly by Promise.all; a synchronous throw is caught by
          // the surrounding try because the map runs inside it. A rejection
          // means the source gave up producing (a dead channel), which is a
          // state operators must be able to alarm on: emit the per-source
          // event here, before the route-level abort below, so listeners see
          // which ingress died even on a multi-ingress route. A rejection
          // after the source's controller aborted is teardown noise (an
          // orderly stop, or a sibling being torn down because another
          // source already failed), not a dead channel: skip the event.
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
      if (!this.abortController.signal.aborted) {
        this.abortController.abort(err);
      }
      throw err;
    }

    // Every ingress's subscription resolved. For a multi-ingress route whose
    // sources are all finite this means every ingress has completed: mirror the
    // single-source contract (where a finite source aborts the route's own
    // controller on completion) by aborting here so the route's terminal
    // lifecycle events fire even when an indefinite sibling route keeps the
    // context alive. A route holding any server ingress never reaches this with
    // an un-aborted controller (a server's subscribe only resolves once the
    // controller is aborted), so the guard makes this a no-op there. The
    // single-source path is left exactly as before: its source drives
    // completion.
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
      const inputSchemas = this.definition.discovery?.input;
      const hasInputSchema = !!inputSchemas?.body || !!inputSchemas?.headers;

      const internals = EXCHANGE_INTERNALS.get(exchange);
      if (internals) {
        if (parse) {
          // Stash the source-supplied parser so `runPipeline` applies it
          // as a synthetic first pipeline step. This is what makes parse
          // errors surface as normal pipeline events the route can
          // observe (`.error()` for `'fail'`, `exchange:dropped` for
          // `'drop'`). See #187.
          internals.parse = parse;
          internals.parseFailureMode = parseFailureMode ?? "fail";
        }
        // Stash the `.input()` validator alongside. With a parser the
        // synthetic parse step runs it once parse succeeds (input
        // validates the parsed body, not the raw bytes); without one
        // `runPipeline` inserts a standalone input step in the same
        // chain position. The non-emitting variant throws RC5002
        // cleanly into the step loop's catch path (which emits
        // `step:failed` and then the error path), without firing
        // duplicate `exchange:started` / stray `exchange:dropped`
        // events (see #187, #447).
        if (hasInputSchema && inputSchemas) {
          internals.applyValidation = (ex: Exchange) =>
            validateInputOrThrow(this.validationDeps(), ex, inputSchemas);
        }
      }

      return this.handler(exchange);
    };
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
    this.abortController.abort("Route stop() called");
  }

  /**
   * Process an exchange through the route's steps.
   * Resolves with the result immediately; then waits for background tasks (e.g. tap) before cleanup.
   *
   * @param exchange The initial exchange to process
   * @returns A promise that resolves when processing is complete
   * @private
   */
  private handler(exchange: Exchange): Promise<Exchange> {
    exchange.logger.debug({ operation: "from" }, "Processing initial exchange");

    const startTime = Date.now();

    // Emit exchange:started event
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
    ).then(async (result) => {
      // Framework-level output validation runs on successful, non-dropped
      // exchanges before we declare completion. A failure falls through the
      // same path as a thrown step: errorHandler if set, else a failed result.
      // A parked exchange is exempt from the output stage AND from
      // completion: its body is the `Suspended` acknowledgment rather than
      // the route's declared output (the two arms of the route's
      // `Output | Suspended` type), and its terminal event was
      // `route:exchange:suspended`. The source still receives the exchange,
      // which is how each transport renders the acknowledgment.
      const finalResult = await applyOutputStage(
        this.validationDeps(),
        this.definition.discovery?.output,
        result,
        startTime,
      );

      if (
        !finalResult.failed &&
        !finalResult.dropped &&
        !finalResult.suspended
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

    // Track in-flight work. Use a catch-suppressed wrapper so rejected
    // handler promises don't trigger unhandled rejection warnings; the
    // actual rejection is handled by the caller (source adapter / channel).
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
   * @internal
   */
  runContinuation(
    exchange: Exchange,
    steps: ReadonlyArray<Step<Adapter>>,
  ): Promise<DetachedResult> {
    const run = runDetachedPipeline(
      this.executorDeps(),
      steps,
      exchange,
      "resume",
    );
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
    // The re-entry is a run of this route in its own right, so it gets its
    // own started / terminal pair rather than leaving a stray `failed` with
    // no `started` before it. `.output()` validation is deliberately NOT
    // applied to a recovered body: what a re-ask handler returns is a
    // notification, not the route's output.
    this.context.emit("route:exchange:started", {
      routeId: this.definition.id,
      exchangeId: exchange.id,
      correlationId,
    });
    const deps: ExecutorDeps = {
      // The memoised deps carry the route's own `buildForward`, so the
      // re-ask handler forwards as the SUSPENDED exchange: its `forward()`
      // takes the correlation of the work being re-asked about, and its
      // principal, which came back from the store marked restored. A target
      // declaring `.authorize()` refuses it for that reason (RC5043), which
      // is the correct answer: nothing re-verified that identity across the
      // park.
      ...this.executorDeps(),
      definition: detachedDefinition(
        this.definition,
        [
          {
            operation: OperationType.PROCESS,
            label: operation,
            // Derived from the caller's label rather than pinned to the
            // resume operation: a cancellation sweeper or an operator deny
            // path pushing into this channel must not have its failures
            // attributed to resume in telemetry.
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
      const { getDirectChannel, sanitizeEndpoint } =
        await import("./adapters/direct/shared.ts");
      const sanitized = sanitizeEndpoint(endpoint as string);
      const channel = getDirectChannel(this.context, sanitized, {});
      const forwardExchange = this.buildExchange(payload, caller.headers);
      const result = await channel.send(sanitized, forwardExchange);
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
