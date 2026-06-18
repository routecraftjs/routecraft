import { randomUUID } from "node:crypto";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { type CraftContext } from "./context.ts";
import {
  type Exchange,
  HeadersKeys,
  OperationType,
  type ExchangeHeaders,
  DefaultExchange,
  EXCHANGE_INTERNALS,
  isDropped,
} from "./exchange.ts";
import { type RegisteredDirectEndpoint } from "./registry.ts";
import {
  resolveAdapterOverride,
  wrapSourceWithOverride,
} from "./testing-hooks.ts";
import { BRAND, INTERNALS_KEY, setBrand } from "./brand.ts";
import { rcError, RC } from "./error.ts";
import { isRoutecraftError } from "./brand.ts";
import { logger, childBindings } from "./logger.ts";
import { type Source, type Subscription } from "./operations/from.ts";
import { type ResolvedRetryOptions } from "./operations/retry-wrapper.ts";
import { type ResolvedTimeoutOptions } from "./operations/timeout-wrapper.ts";
import { type CircuitBreakerController } from "./operations/circuit-breaker-wrapper.ts";
import { type ConcurrencyController } from "./operations/concurrency-wrapper.ts";
import {
  type Adapter,
  type Step,
  type Consumer,
  type ConsumerType,
  type Message,
  type ProcessingQueue,
} from "./types.ts";
import { InMemoryProcessingQueue } from "./queue.ts";
import {
  buildCacheCheckStep,
  buildCacheStoreStep,
  buildThrottleCheckStep,
} from "./pipeline/synthetic-steps.ts";
import {
  applyInputValidation,
  applyOutputValidation,
  handleOutputValidationFailure,
  validateInputOrThrow,
  type ValidationDeps,
} from "./pipeline/validation.ts";
import { runPipeline, type ExecutorDeps } from "./pipeline/executor.ts";

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
  | "read-only"
  | "destructive"
  | "idempotent"
  | "open-world";

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
   * Build a forward function the route uses to delegate from an
   * error / fallback handler to another route via the direct adapter.
   * Exposed so step-scope `WrapperStep` subclasses can hand the same
   * callable to a user-supplied handler as the route-level pipeline
   * does.
   *
   * @internal
   */
  getForward(): ForwardFn;
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
      | string
      | undefined;
    const builtHeaders: Record<string, unknown> = {
      ...headers,
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
      buildForward: () => this.buildForward(),
    };
    return this.cachedExecutorDeps;
  }

  /** Assemble the deps object for the pipeline validation helpers (memoized, see {@link executorDeps}). */
  private validationDeps(): ValidationDeps {
    if (!this.cachedValidationDeps) {
      const deps: ValidationDeps = {
        routeId: this.definition.id,
        context: this.context,
        logger: this.logger,
        route: this,
        buildForward: () => this.buildForward(),
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
    // Framework-level input validation runs here, before the step pipeline,
    // so any source adapter with an `.input()` schema on the route inherits
    // validation without per-adapter wiring. On failure the engine emits
    // `exchange:dropped` for telemetry and re-throws so the source's own
    // caller (e.g. a direct channel's `send`) sees the validation error.
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
   * applies framework-level `.input()` validation (eagerly, or deferred to the
   * synthetic parse step when the source supplies a parser) before running the
   * route's steps.
   */
  private buildConsumerHandler(): (envelope: Message) => Promise<Exchange> {
    return async ({ message, headers, parse, parseFailureMode }) => {
      const initialExchange = this.buildExchange(message, headers);
      const inputSchemas = this.definition.discovery?.input;
      const hasInputSchema = !!inputSchemas?.body || !!inputSchemas?.headers;

      let exchange: Exchange = initialExchange;
      if (parse) {
        // Stash the source-supplied parser on exchange internals so
        // `runPipeline` can apply it as a synthetic first pipeline step.
        // This is what makes parse errors surface as normal pipeline
        // events the route can observe (`.error()` for `'fail'`,
        // `exchange:dropped` for `'drop'`). See #187.
        const internals = EXCHANGE_INTERNALS.get(exchange);
        if (internals) {
          internals.parse = parse;
          internals.parseFailureMode = parseFailureMode ?? "fail";
          // Validation must run AFTER parse so `.input()` schemas
          // validate the parsed body, not the raw bytes. The synthetic
          // parse step calls this hook once parse succeeds. Use the
          // non-emitting variant so a validation failure inside the parse
          // step throws RC5002 cleanly into the step loop's catch path
          // (which emits `step:failed` and then `exchange:failed`),
          // without firing duplicate `exchange:started` /
          // `exchange:dropped` events (see #187).
          if (hasInputSchema && inputSchemas) {
            internals.applyValidation = (ex: Exchange) =>
              validateInputOrThrow(this.validationDeps(), ex, inputSchemas);
          }
        }
      } else if (hasInputSchema && inputSchemas) {
        // No parse: run validation eagerly. The validated exchange
        // replaces the initial one; with frozen headers/body the
        // validator returns a new instance via `rewrap`.
        exchange = await applyInputValidation(
          this.validationDeps(),
          exchange,
          inputSchemas,
        );
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
      let finalResult = result;
      if (!result.failed && !result.dropped) {
        const outputSchemas = this.definition.discovery?.output;
        if (outputSchemas?.body || outputSchemas?.headers) {
          try {
            const validated = await applyOutputValidation(
              this.validationDeps(),
              result.exchange,
              outputSchemas,
            );
            finalResult = { ...result, exchange: validated };
          } catch (err) {
            finalResult = await handleOutputValidationFailure(
              this.validationDeps(),
              result.exchange,
              err,
              startTime,
              outputSchemas,
            );
          }
        }
      }

      if (!finalResult.failed && !finalResult.dropped) {
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
   * Build a forward function that sends a payload to another route via the direct adapter.
   *
   * Exposed (`@internal`) so step-scope `WrapperStep` subclasses can hand
   * the same forward callable to a user-supplied error / fallback handler
   * as the route-level pipeline does. Resolve via
   * `getExchangeRoute(exchange).getForward()`.
   *
   * @returns A forward function
   */
  getForward(): ForwardFn {
    return this.buildForward();
  }

  /**
   * Build a forward function that sends a payload to another route via the direct adapter.
   *
   * @returns A forward function
   * @private
   */
  private buildForward(): ForwardFn {
    return async (
      endpoint: RegisteredDirectEndpoint,
      payload: unknown,
    ): Promise<unknown> => {
      const { getDirectChannel, sanitizeEndpoint } =
        await import("./adapters/direct/shared.ts");
      const sanitized = sanitizeEndpoint(endpoint as string);
      const channel = getDirectChannel(this.context, sanitized, {});
      const forwardExchange = this.buildExchange(payload);
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
    this.logger.debug(
      { inFlight: this.inFlight.size },
      "Draining route: waiting for in-flight handlers and tasks",
    );
    while (this.inFlight.size > 0) {
      const current = [...this.inFlight];
      await Promise.allSettled(current);
    }
    this.logger.debug({}, "Route drained");
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
