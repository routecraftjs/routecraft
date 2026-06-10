import { randomUUID } from "node:crypto";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { type CraftContext } from "./context.ts";
import type { EventName } from "./types.ts";
import {
  type Exchange,
  HeadersKeys,
  OperationType,
  type ExchangeHeaders,
  DefaultExchange,
  EXCHANGE_INTERNALS,
  isDropped,
  setStartedAt,
} from "./exchange.ts";
import { type RegisteredDirectEndpoint } from "./registry.ts";
import { SPLIT_PARENT_STORE } from "./operations/split.ts";
import {
  resolveAdapterOverride,
  wrapSourceWithOverride,
} from "./testing-hooks.ts";
import { BRAND, INTERNALS_KEY, setBrand } from "./brand.ts";
import { rcError, RoutecraftError, RC } from "./error.ts";
import { isRoutecraftError } from "./brand.ts";
import { logger, childBindings } from "./logger.ts";
import { type Source } from "./operations/from.ts";
import { type OnParseError } from "./adapters/shared/parse.ts";
import {
  type Adapter,
  type Step,
  getAdapterLabel,
  type Consumer,
  type ConsumerType,
  type Message,
  type ProcessingQueue,
} from "./types.ts";
import { InMemoryProcessingQueue } from "./queue.ts";
import {
  buildParseStep,
  buildCacheCheckStep,
  buildCacheStoreStep,
} from "./pipeline/synthetic-steps.ts";
import {
  applyInputValidation,
  applyOutputValidation,
  handleOutputValidationFailure,
  validateInputOrThrow,
  type ValidationDeps,
} from "./pipeline/validation.ts";

// Re-exported for existing imports (builder.ts and @internal consumers).
export { buildCacheCheckStep, buildCacheStoreStep };

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
 * @param error - The thrown error
 * @param exchange - The exchange at the point of failure
 * @param forward - Sends a payload to another route via the direct adapter
 * @returns Static fallback value or result of forward()
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
   * `cache-check` filter (chain position #9). Future resilience
   * wrappers (`throttle`, `circuitBreaker`, `retry`, `timeout` at
   * positions #5-#8) slot in between input and cacheCheck once they
   * land.
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
        new this.definition.consumer.type(
          this.context,
          this.definition,
          channel,
          this.definition.consumer.options,
        ),
    );

    // Emit routeStopping/routeStopped when the controller is aborted externally
    this.abortController.signal.addEventListener("abort", (event) => {
      try {
        this.context.emit(`route:${this.definition.id}:stopping` as EventName, {
          route: this,
          reason: (event as unknown as { reason?: unknown })?.reason,
        });
      } finally {
        this.context.emit(`route:${this.definition.id}:stopped` as EventName, {
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

  /** Assemble the deps object for the pipeline validation helpers. */
  private validationDeps(): ValidationDeps {
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
    return deps;
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
        this.context.emit(`route:${this.definition.id}:started` as EventName, {
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
          // Coerce to a promise so a void return and an async rejection are
          // handled uniformly by Promise.all; a synchronous throw is caught by
          // the surrounding try because the map runs inside it.
          return Promise.resolve(
            activeSource.subscribe(
              this.context,
              (message, headers, parse, parseFailureMode) => {
                markReady(index); // fallback: fire before first message if adapter never called onReady
                return channel.enqueue({
                  message,
                  headers: headers ?? {},
                  ...(parse
                    ? {
                        parse: parse as (
                          raw: unknown,
                        ) => unknown | Promise<unknown>,
                        parseFailureMode: parseFailureMode ?? "fail",
                      }
                    : {}),
                });
              },
              sourceController,
              () => markReady(index),
              meta,
            ),
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
  private buildConsumerHandler(): (
    message: unknown,
    headers?: ExchangeHeaders,
    parse?: (raw: unknown) => unknown | Promise<unknown>,
    parseFailureMode?: OnParseError,
  ) => Promise<Exchange> {
    return async (message, headers, parse, parseFailureMode) => {
      const initialExchange = this.buildExchange(message, headers);
      const inputSchemas = this.definition.discovery?.input;
      const hasInputSchema = !!inputSchemas?.body || !!inputSchemas?.headers;

      let exchange: Exchange = initialExchange;
      if (parse) {
        // Stash the source-supplied parser on exchange internals so
        // `runSteps` can apply it as a synthetic first pipeline step.
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
    this.context.emit(`route:${this.definition.id}:exchange:started` as const, {
      routeId: this.definition.id,
      exchangeId: exchange.id,
      correlationId,
    });

    // Run steps (tap adds tasks via route.trackTask)
    const handlerPromise = this.runSteps(exchange, startTime).then(
      async (result) => {
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
          this.context.emit(
            `route:${this.definition.id}:exchange:completed` as const,
            {
              routeId: this.definition.id,
              exchangeId: exchange.id,
              correlationId,
              duration,
              exchange: finalResult.exchange,
            },
          );
        }

        // Reject so callers (CraftClient, direct channel) can handle the error.
        // Source adapters catch this rejection and continue processing.
        if (finalResult.failed && finalResult.error) {
          throw finalResult.error;
        }

        return finalResult.exchange;
      },
    );

    // Track in-flight work. Use a catch-suppressed wrapper so rejected
    // handler promises don't trigger unhandled rejection warnings; the
    // actual rejection is handled by the caller (source adapter / channel).
    const tracked = handlerPromise.catch(() => {});
    this.inFlight.add(tracked);
    tracked.finally(() => this.inFlight.delete(tracked));

    return handlerPromise;
  }

  /**
   * Run the step loop for an exchange.
   *
   * @param exchange The initial exchange to process
   * @param startTime The timestamp when exchange processing started (for duration calculation)
   * @returns The last processed exchange
   * @private
   */
  private async runSteps(
    exchange: Exchange,
    startTime: number,
  ): Promise<{
    exchange: Exchange;
    failed: boolean;
    dropped: boolean;
    error?: unknown;
  }> {
    // If the source adapter attached a `parse` function (see #187), prepend
    // a synthetic step that runs it before any user-defined steps. The step
    // throws an `RC5016` error on parse failure, which then flows through
    // the same error-handler path as any other step error: the route's
    // `.error()` handler is invoked, or `exchange:failed` fires.
    const internals = EXCHANGE_INTERNALS.get(exchange);
    const sourceParse = internals?.parse;
    const sourceValidate = internals?.applyValidation;
    const sourceFailureMode = internals?.parseFailureMode ?? "fail";
    if (internals && sourceParse) {
      // Clear so parse never runs twice on the same exchange (e.g. if the
      // exchange is forwarded back through the queue).
      delete internals.parse;
      delete internals.parseFailureMode;
      delete internals.applyValidation;
    }

    // The route's pre-from filter chain (assembled at builder time in
    // the framework-fixed order documented at
    // `.standards/pre-from-filter-chain.md`). Parse is dynamic per
    // exchange (source-attached) and is interleaved between the two
    // pre-from arrays:
    //
    //   preParseFilters    -> .authorize()
    //   (parse if present) -> source-attached
    //   postParseFilters   -> .cache() check, future
    //                         .throttle() / .circuitBreaker() / .retry() /
    //                         .timeout() (positions 5-8 in the chain doc)
    //   userSteps          -> declaration order, unchanged
    //   postFromFilters    -> .cache() store
    //
    // The route's `.error()` handler wraps the queue loop (filter
    // position #1 in the chain doc); it is implemented as a try/catch
    // around the user pipeline, not a step that calls `next()`.
    //
    // The cache key flows from cache-check to cache-store via
    // `internals.cacheKey` on the exchange -- per-invocation, no
    // shared closure -- so the filter steps can be constructed once
    // at builder time.
    const initialSteps: Step<Adapter>[] = [
      ...this.definition.preParseFilters,
      ...(sourceParse
        ? [buildParseStep(sourceParse, sourceFailureMode, sourceValidate)]
        : []),
      ...this.definition.postParseFilters,
      ...this.definition.steps,
      ...this.definition.postFromFilters,
    ];

    const queue: { exchange: Exchange; steps: Step<Adapter>[] }[] = [
      { exchange: exchange, steps: initialSteps },
    ];

    let lastProcessedExchange: Exchange = exchange;
    let failed = false;
    let dropped = false;
    let stepError: unknown;
    // Track child exchanges so we can emit exchange:started/completed for them.
    // The parent exchange (first one) is handled by handler().
    const parentExchangeId = exchange.id;
    const seenChildExchanges = new Set<string>();
    const childStartTimes = new Map<string, number>();
    const failedChildExchanges = new Set<string>();

    // Snapshot existing split parent keys so cleanup only touches groups
    // created during THIS invocation, not groups from concurrent handlers.
    const parentMap = this.context.getStore(SPLIT_PARENT_STORE) as
      | Map<string, Exchange>
      | undefined;
    const preExistingGroups = parentMap
      ? new Set(parentMap.keys())
      : new Set<string>();

    while (queue.length > 0) {
      const popped = queue.shift()!;
      const { steps } = popped;
      // `let` because the engine may rewrap the exchange below to update
      // bookkeeping headers (operation label) without mutating the frozen
      // wrapper. Subsequent reads in this iteration use the rewrapped value.
      let exchange = popped.exchange;
      if (steps.length === 0) {
        // Emit exchange:completed for child exchanges when their steps are done
        if (
          exchange.id !== parentExchangeId &&
          seenChildExchanges.has(exchange.id) &&
          !failedChildExchanges.has(exchange.id)
        ) {
          const childStart = childStartTimes.get(exchange.id) ?? startTime;
          const correlationId = exchange.headers[
            HeadersKeys.CORRELATION_ID
          ] as string;
          this.context.emit(
            `route:${this.definition.id}:exchange:completed` as const,
            {
              routeId: this.definition.id,
              exchangeId: exchange.id,
              correlationId,
              duration: Date.now() - childStart,
              exchange,
            },
          );
        }
        lastProcessedExchange = exchange;
        continue;
      }

      // Emit exchange:started for child exchanges on first encounter
      if (
        exchange.id !== parentExchangeId &&
        !seenChildExchanges.has(exchange.id)
      ) {
        seenChildExchanges.add(exchange.id);
        const childNow = Date.now();
        childStartTimes.set(exchange.id, childNow);
        // Stash the start timestamp on the exchange's internals so
        // aggregate (and other observers) can read child duration without
        // a side-Map handed across module boundaries. Internals survive
        // `rewrap` because rewrap shares them between prev and next.
        setStartedAt(exchange, childNow);
        const correlationId = exchange.headers[
          HeadersKeys.CORRELATION_ID
        ] as string;
        this.context.emit(
          `route:${this.definition.id}:exchange:started` as const,
          {
            routeId: this.definition.id,
            exchangeId: exchange.id,
            correlationId,
          },
        );
      }

      const [step, ...remainingSteps] = steps;

      // Prefer the DSL label (e.g., "log") over the raw OperationType (e.g., "tap")
      const stepLabel = step.label ?? step.operation;

      // Update the operation header for this step. Headers are frozen, so
      // we rewrap onto a derived exchange (preserves id and internals).
      // The cost is one allocation per step on top of whatever the step
      // itself produces; in practice the dominant cost is still I/O.
      exchange = DefaultExchange.rewrap(exchange, {
        headers: { ...exchange.headers, [HeadersKeys.OPERATION]: stepLabel },
      });

      const adapterLabel = getAdapterLabel(step.adapter);
      exchange.logger.debug(
        {
          operation: stepLabel,
          ...(adapterLabel ? { adapter: adapterLabel } : {}),
        },
        "Processing step",
      );

      const stepStartTime = Date.now();
      const correlationId = exchange.headers[
        HeadersKeys.CORRELATION_ID
      ] as string;

      // Emit step:started event unless the step manages its own events
      if (!step.skipStepEvents) {
        this.context.emit(`route:${this.definition.id}:step:started` as const, {
          routeId: this.definition.id,
          exchangeId: exchange.id,
          correlationId,
          operation: stepLabel,
          ...(adapterLabel ? { adapter: adapterLabel } : {}),
        });
      }

      try {
        await step.execute(exchange, remainingSteps, queue);

        // Emit step:completed event unless the step manages its own events
        if (!step.skipStepEvents) {
          const stepDuration = Date.now() - stepStartTime;
          const correlationId = exchange.headers[
            HeadersKeys.CORRELATION_ID
          ] as string;
          this.context.emit(
            `route:${this.definition.id}:step:completed` as const,
            {
              routeId: this.definition.id,
              exchangeId: exchange.id,
              correlationId,
              operation: stepLabel,
              ...(adapterLabel ? { adapter: adapterLabel } : {}),
              duration: stepDuration,
            },
          );
        }
      } catch (error) {
        const err = this.processError(stepLabel, error);
        const correlationId = exchange.headers[
          HeadersKeys.CORRELATION_ID
        ] as string;
        const duration = Date.now() - startTime;

        // Emit step-level error
        this.context.emit(
          `route:${this.definition.id}:step:${stepLabel}:error` as EventName,
          {
            error: err,
            route: this,
            exchange,
            operation: stepLabel,
          },
        );

        if (this.definition.errorHandler) {
          // Route-scope error-handler events. Step-scope wrappers
          // emit the same set with `scope: "step"` and `stepLabel`.
          this.context.emit(
            `route:${this.definition.id}:error-handler:invoked` as const,
            {
              routeId: this.definition.id,
              exchangeId: exchange.id,
              correlationId,
              originalError: err,
              failedOperation: stepLabel,
              scope: "route",
            },
          );

          try {
            const forward = this.buildForward();
            const result = await this.definition.errorHandler(
              err,
              exchange,
              forward,
            );
            // Replace body via rewrap (frozen exchange); keep id and
            // internals so telemetry continues to reference the same
            // logical exchange.
            const recovered = DefaultExchange.rewrap(exchange, {
              body: result,
            });
            lastProcessedExchange = recovered;

            // Error handler recovered
            this.context.emit(
              `route:${this.definition.id}:error:caught` as EventName,
              {
                error: err,
                route: this,
                exchange: recovered,
              },
            );
            this.context.emit(
              `route:${this.definition.id}:error-handler:recovered` as const,
              {
                routeId: this.definition.id,
                exchangeId: recovered.id,
                correlationId,
                originalError: err,
                failedOperation: stepLabel,
                recoveryStrategy: "route-error-handler",
                scope: "route",
              },
            );
          } catch (handlerError) {
            const handlerErr = this.processError(stepLabel, handlerError);
            exchange.logger.error(
              {
                operation: stepLabel,
                err: handlerErr,
                context: "error handler",
              },
              handlerErr.meta.message,
            );
            this.context.emit(
              `route:${this.definition.id}:error-handler:failed` as const,
              {
                routeId: this.definition.id,
                exchangeId: exchange.id,
                correlationId,
                originalError: err,
                failedOperation: stepLabel,
                recoveryStrategy: "route-error-handler",
                scope: "route",
              },
            );
            // Error handler rethrew -- route-level + context-level error
            this.context.emit(
              `route:${this.definition.id}:error` as EventName,
              {
                error: handlerErr,
                route: this,
                exchange,
              },
            );
            this.context.emit("context:error", {
              error: handlerErr,
              route: this,
              exchange,
            });
            this.context.emit(
              `route:${this.definition.id}:exchange:failed` as const,
              {
                routeId: this.definition.id,
                exchangeId: exchange.id,
                correlationId,
                duration,
                error: handlerErr,
                exchange,
              },
            );
            if (exchange.id !== parentExchangeId) {
              failedChildExchanges.add(exchange.id);
            } else {
              failed = true;
              stepError = handlerErr;
            }
          }

          // Pipeline does not resume after error handler (success or failure)
          return {
            exchange: lastProcessedExchange,
            failed,
            dropped,
            error: stepError,
          };
        }

        // No error handler -- route-level error
        exchange.logger.error(
          {
            operation: stepLabel,
            ...(adapterLabel ? { adapter: adapterLabel } : {}),
            err,
          },
          err.meta.message,
        );
        // No error handler -- route-level + context-level error
        this.context.emit(`route:${this.definition.id}:error` as EventName, {
          error: err,
          route: this,
          exchange,
        });
        this.context.emit("context:error", {
          error: err,
          route: this,
          exchange,
        });
        this.context.emit(
          `route:${this.definition.id}:exchange:failed` as const,
          {
            routeId: this.definition.id,
            exchangeId: exchange.id,
            correlationId,
            duration,
            error: err,
            exchange,
          },
        );
        if (exchange.id !== parentExchangeId) {
          failedChildExchanges.add(exchange.id);
        } else {
          failed = true;
          stepError = err;
        }

        // Don't re-throw - error is logged and emitted via events.
        // The error is returned in the result so callers (e.g. CraftClient)
        // can handle it. Source adapters catch and continue.
        // Do NOT return here: the while loop continues so other queue items (e.g. split children) are processed
      }
    }

    // Clean up orphaned split parent map entries added during THIS invocation.
    // Only touch groups that did not exist before runSteps started, to avoid
    // deleting entries owned by concurrent handlers on the same context.
    if (parentMap && parentMap.size > 0) {
      for (const groupId of Array.from(parentMap.keys())) {
        if (preExistingGroups.has(groupId)) continue;
        const parentEx = parentMap.get(groupId);
        if (parentEx) {
          const hierarchy = parentEx.headers[HeadersKeys.SPLIT_HIERARCHY] as
            | string[]
            | undefined;
          // Only clean up groups that are NOT part of a nested hierarchy
          if (!hierarchy || !hierarchy.includes(groupId)) {
            parentMap.delete(groupId);
          }
        }
      }
    }

    // Check if the root exchange was dropped (e.g. by a filter). The drop
    // flag lives on the exchange's shared internals object (see
    // `markDropped` / `isDropped` in `exchange.ts`), so it survives the
    // engine's per-step `rewrap`: an operation that marks the rewrapped
    // exchange handed to it remains visible from the outer parameter
    // because both reference the same internals.
    if (isDropped(exchange)) {
      dropped = true;
    }

    // Route-scope cache writes (`cacheConfig`) are handled inline by
    // the `cache-store` synthetic step appended to `initialSteps` at
    // the top of this function. Nothing to do here.

    return {
      exchange: lastProcessedExchange,
      failed,
      dropped,
      error: stepError,
    };
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

  /**
   * Normalize an operation error into a RoutecraftError.
   * If the error is already a RoutecraftError, it is returned unchanged.
   *
   * @param _operation - The operation that caused the error (for logging)
   * @param error - The thrown value (Error or RoutecraftError)
   * @returns A RoutecraftError (existing or RC5001-wrapped)
   * @private
   */
  private processError(
    _operation: OperationType | string,
    error: unknown,
  ): RoutecraftError {
    if (isRoutecraftError(error)) {
      return error as RoutecraftError;
    }
    const msg = error instanceof Error ? error.message : String(error);
    return rcError("RC5001", error, { message: msg });
  }
}
