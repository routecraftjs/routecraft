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
} from "./exchange.ts";
import { type RegisteredDirectEndpoint } from "./registry.ts";
import { SPLIT_PARENT_STORE } from "./operations/split.ts";
import {
  resolveAdapterOverride,
  wrapSourceWithOverride,
} from "./testing-hooks.ts";
import { BRAND, INTERNALS_KEY, setBrand } from "./brand.ts";
import { rcError, RoutecraftError, RC, formatSchemaIssues } from "./error.ts";
import { isRoutecraftError } from "./brand.ts";
import { logger, childBindings } from "./logger.ts";
import { type Source } from "./operations/from.ts";
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
export type KnownTag = "read-only" | "destructive" | "idempotent";

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
   * Tags used by tag-based selectors (e.g. agents whitelisting
   * `{ tagged: "read-only" }`). Empty/missing means no tags.
   */
  tags?: Tag[];
}

/**
 * Synthetic adapter used as the carrier for the parse step. Has no behaviour;
 * the step's `execute` does the work.
 */
const PARSE_STEP_ADAPTER: Adapter = { adapterId: "routecraft.parse" };

/**
 * Stable `reason` string emitted on `exchange:dropped` when a parsing source
 * with `onParseError: 'drop'` rejects a malformed item. Mirrors the constant
 * exported from `adapters/shared/parse.ts`. Subscribers can filter on this:
 *
 * ```ts
 * ctx.on('route:*:exchange:dropped', ({ details }) => {
 *   if (details.reason === 'parse-failed') metrics.increment('parse.dropped');
 * });
 * ```
 */
const PARSE_DROPPED_REASON = "parse-failed";

/**
 * Build a synthetic pipeline step that runs a source-supplied parse function
 * against the exchange body. Inserted by `runSteps` as the first step when a
 * source attaches `parse` to its message; this is what makes parse failures
 * observable as normal pipeline events (rather than aborting the source).
 * See #187.
 *
 * Behaviour on parse failure depends on `failureMode`:
 * - `"fail"` / `"abort"`: throw `RC5016` so `exchange:failed` fires (or the
 *   route's `.error()` handler recovers). The adapter's caller distinguishes
 *   `"abort"` by re-throwing the rejection out of subscribe.
 * - `"drop"`: emit `exchange:dropped` with `reason: "parse-failed"` (matching
 *   filter / validate drop semantics) and halt the pipeline cleanly without
 *   invoking `.error()`.
 *
 * When `applyValidation` is supplied, it runs immediately after a successful
 * parse so route-level `.input()` schemas validate the parsed body, not the
 * raw bytes. Validation failure throws out of `applyValidation` and is
 * handled by the step loop's catch path like any step error.
 *
 * The step manages its own `step:started` / `step:completed` / `step:failed`
 * lifecycle events (`skipStepEvents: true`) so we can emit `step:completed`
 * for the drop case (drops are not failures) without the route loop
 * double-emitting.
 */
function buildParseStep(
  parse: (raw: unknown) => unknown | Promise<unknown>,
  failureMode: "fail" | "abort" | "drop",
  applyValidation?: (exchange: Exchange) => Promise<void>,
): Step<Adapter> {
  return {
    operation: OperationType.PARSE,
    label: "parse",
    adapter: PARSE_STEP_ADAPTER,
    skipStepEvents: true,
    async execute(exchange, remainingSteps, queue) {
      const internals = EXCHANGE_INTERNALS.get(exchange);
      const context = internals?.context;
      const route = internals?.route;
      const routeId =
        route?.definition.id ??
        (exchange.headers[HeadersKeys.ROUTE_ID] as string);
      const correlationId = exchange.headers[
        HeadersKeys.CORRELATION_ID
      ] as string;
      const stepStart = Date.now();

      const emitStepStarted = () => {
        context?.emit(`route:${routeId}:step:started` as EventName, {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          operation: "parse",
          adapter: "parse",
        });
      };
      const emitStepCompleted = () => {
        context?.emit(`route:${routeId}:step:completed` as EventName, {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          operation: "parse",
          adapter: "parse",
          duration: Date.now() - stepStart,
        });
      };
      const emitStepFailed = (err: unknown) => {
        context?.emit(`route:${routeId}:step:failed` as EventName, {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          operation: "parse",
          adapter: "parse",
          duration: Date.now() - stepStart,
          error: err instanceof Error ? err.message : String(err),
        });
      };

      emitStepStarted();

      try {
        exchange.body = await parse(exchange.body);
      } catch (cause) {
        if (failureMode === "drop") {
          // Drops are not failures: emit step:completed (the step itself
          // ran cleanly), then exchange:dropped with a stable reason.
          emitStepCompleted();
          context?.emit(`route:${routeId}:exchange:dropped` as EventName, {
            routeId,
            exchangeId: exchange.id,
            correlationId,
            reason: PARSE_DROPPED_REASON,
            exchange,
          });
          // Mark dropped so the route engine does not emit
          // exchange:completed for this exchange.
          exchange.headers["routecraft.dropped"] = true;
          return;
        }
        // 'fail' / 'abort': throw RC5016 so the step loop's catch path
        // emits exchange:failed (or invokes the route's `.error()`).
        emitStepFailed(cause);
        const causeMessage =
          cause instanceof Error ? cause.message : String(cause);
        throw rcError("RC5016", cause, {
          message: `Source payload parse failed: ${causeMessage}`,
        });
      }

      if (applyValidation) {
        try {
          await applyValidation(exchange);
        } catch (cause) {
          emitStepFailed(cause);
          throw cause;
        }
      }

      emitStepCompleted();
      // Hand control back to the step loop with the user's pipeline.
      queue.push({ exchange, steps: remainingSteps });
    },
  };
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
 *   source: simple('hello'),
 *   steps: [...],
 *   consumer: { type: SimpleConsumer, options: undefined }
 * };
 * ```
 */
export type RouteDefinition<T = unknown> = {
  /** Unique identifier for the route */
  readonly id: string;

  /** The source that provides data to the route */
  readonly source: Source<T>;

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
   * Start processing: subscribe to the source and begin delivering messages through the steps.
   * @returns Promise that resolves when the source has been subscribed and the consumer is ready
   */
  start(): Promise<void>;

  /**
   * Stop the route: abort the source subscription and clear the internal queue.
   */
  stop(): void;

  /**
   * Wait until all in-flight message handlers and tracked tasks (e.g. tap) have completed.
   * Does not stop the route; use stop() to abort the source.
   */
  drain(): Promise<void>;

  /**
   * Track a background task (e.g. tap) for this route.
   * @param promise The promise to track
   * @internal
   */
  trackTask(promise: Promise<unknown>): void;
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

  /** Internal queue for passing messages between the source and consumer */
  private messageChannel: ProcessingQueue<Message>;

  /** Processes messages from the message channel */
  private consumer: Consumer;

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
    this.messageChannel = new InMemoryProcessingQueue<Message>();
    this.consumer = new this.definition.consumer.type(
      this.context,
      this.definition,
      this.messageChannel,
      this.definition.consumer.options,
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
   * @param message The message data
   * @param headers Optional headers to include
   * @returns A new Exchange object
   * @private
   */
  private buildExchange(message: unknown, headers?: ExchangeHeaders): Exchange {
    const exchange = new DefaultExchange(this.context, {
      body: message,
      headers: {
        ...headers,
        [HeadersKeys.CORRELATION_ID]: randomUUID(),
        [HeadersKeys.ROUTE_ID]: this.definition.id,
        [HeadersKeys.OPERATION]: OperationType.FROM,
      },
    });

    // Add route to internals so steps like tap can access it (symbol-key for cross-instance)
    const internals =
      (
        exchange as Exchange & {
          [key: symbol]: { context: CraftContext; route?: Route };
        }
      )[INTERNALS_KEY] ?? EXCHANGE_INTERNALS.get(exchange);
    if (internals) {
      internals.route = this;
    }

    return exchange;
  }

  /**
   * Run Standard Schema validation against a value. Returns the validated
   * value on success (schemas can legitimately transform to `undefined`,
   * so presence of the `value` key is what decides success, not truthiness)
   * or a human-readable message on failure.
   */
  private async validateAgainst(
    schema: StandardSchemaV1,
    value: unknown,
  ): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
    let result = schema["~standard"].validate(value);
    if (result instanceof Promise) result = await result;
    const issues = (result as { issues?: unknown }).issues;
    if (issues !== undefined && issues !== null) {
      return { ok: false, message: formatSchemaIssues(issues) };
    }
    const successResult = result as { value?: unknown };
    return {
      ok: true,
      value: "value" in successResult ? successResult.value : value,
    };
  }

  /**
   * Validate an incoming exchange against the route's `input` schemas.
   *
   * On success, the exchange body and headers are mutated in place with any
   * validated / coerced values (headers are merged over the originals so
   * pass-through keys like correlation IDs survive schemas that strip
   * unknowns). On failure, emits `exchange:started` followed by
   * `exchange:dropped` for telemetry and throws an RC5002 error so the
   * source's caller (e.g. a direct channel's `send`) sees the rejection.
   */
  private async applyInputValidation(
    exchange: Exchange,
    schemas: { body?: StandardSchemaV1; headers?: StandardSchemaV1 },
  ): Promise<void> {
    if (schemas.body) {
      const res = await this.validateAgainst(schemas.body, exchange.body);
      if (!res.ok) {
        throw this.emitInputValidationFailure(exchange, "body", res.message);
      }
      exchange.body = res.value;
    }
    if (schemas.headers) {
      const res = await this.validateAgainst(schemas.headers, exchange.headers);
      if (!res.ok) {
        throw this.emitInputValidationFailure(exchange, "headers", res.message);
      }
      const headerValue = res.value as ExchangeHeaders | undefined;
      if (headerValue !== undefined) {
        // Merge validated values over the originals in place so caller
        // pass-through keys (correlation IDs, adapter-injected metadata)
        // survive schemas that strip unknowns.
        Object.assign(exchange.headers, headerValue);
      }
    }
  }

  /**
   * Emit exchange:started followed by exchange:dropped for a message that
   * failed framework-level input validation and return the RC5002 error so
   * the caller can throw it. The source's own sender (e.g. a direct
   * channel's `send`) needs the rejection to propagate; pipeline telemetry
   * still sees the drop via the events.
   */
  private emitInputValidationFailure(
    exchange: Exchange,
    direction: "body" | "headers",
    message: string,
  ): RoutecraftError {
    const routeId = this.definition.id;
    const correlationId = (exchange.headers[HeadersKeys.CORRELATION_ID] ??
      exchange.id) as string;

    const err = rcError("RC5002", new Error(message), {
      message: `${direction === "body" ? "Body" : "Header"} validation failed for route "${routeId}"`,
    });

    this.context.emit(`route:${routeId}:exchange:started` as EventName, {
      routeId,
      exchangeId: exchange.id,
      correlationId,
    });
    this.context.emit(`route:${routeId}:exchange:dropped` as EventName, {
      routeId,
      exchangeId: exchange.id,
      correlationId,
      reason: `input validation failed: ${message}`,
      exchange,
    });

    this.logger.warn(
      { err, routeId, direction, operation: "from" },
      `Input ${direction} validation failed; exchange dropped`,
    );

    return err;
  }

  /**
   * Handle an output-validation failure. Delegates to the route's error
   * handler when one is configured (mirroring how step errors recover);
   * otherwise emits `exchange:failed` and returns a failed result so the
   * caller can surface the error.
   */
  private async handleOutputValidationFailure(
    exchange: Exchange,
    error: unknown,
    startTime: number,
  ): Promise<{
    exchange: Exchange;
    failed: boolean;
    dropped: boolean;
    error?: unknown;
  }> {
    const routeId = this.definition.id;
    const correlationId = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;

    this.context.emit(`route:${routeId}:step:output:error` as EventName, {
      error,
      route: this,
      exchange,
      operation: "output",
    });

    if (this.definition.errorHandler) {
      try {
        const forward = this.buildForward();
        const recovered = await this.definition.errorHandler(
          error,
          exchange,
          forward,
        );
        exchange.body = recovered;
        this.context.emit(`route:${routeId}:error:caught` as EventName, {
          error,
          route: this,
          exchange,
        });
        return { exchange, failed: false, dropped: false };
      } catch (handlerErr) {
        this.context.emit(`route:${routeId}:exchange:failed` as const, {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          duration: Date.now() - startTime,
          error: handlerErr,
          exchange,
        });
        return { exchange, failed: true, dropped: false, error: handlerErr };
      }
    }

    this.context.emit(`route:${routeId}:exchange:failed` as const, {
      routeId,
      exchangeId: exchange.id,
      correlationId,
      duration: Date.now() - startTime,
      error,
      exchange,
    });
    return { exchange, failed: true, dropped: false, error };
  }

  /**
   * Validate the final exchange against the route's `output` schemas.
   * On failure, throws an RC5002 error so the normal error / error-handler
   * flow takes over.
   */
  private async applyOutputValidation(
    exchange: Exchange,
    schemas: { body?: StandardSchemaV1; headers?: StandardSchemaV1 },
  ): Promise<void> {
    if (schemas.body) {
      const res = await this.validateAgainst(schemas.body, exchange.body);
      if (!res.ok) {
        throw rcError("RC5002", new Error(res.message), {
          message: `Output body validation failed for route "${this.definition.id}"`,
        });
      }
      exchange.body = res.value;
    }
    if (schemas.headers) {
      const res = await this.validateAgainst(schemas.headers, exchange.headers);
      if (!res.ok) {
        throw rcError("RC5002", new Error(res.message), {
          message: `Output header validation failed for route "${this.definition.id}"`,
        });
      }
      const headerValue = res.value as ExchangeHeaders | undefined;
      if (headerValue !== undefined) {
        Object.assign(exchange.headers, headerValue);
      }
    }
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
   * 1. Registers the consumer to process messages
   * 2. Subscribes to the source to receive data
   *
   * @returns A promise that resolves when the route has started
   * @throws {RoutecraftError} If the route has been aborted
   */
  async start(): Promise<void> {
    this.assertNotAborted();
    // Lifecycle log is emitted only by context (one log per event).

    // Start consuming messages from the internal processing queue.
    // Framework-level input validation runs here, before the step pipeline,
    // so any source adapter with an `.input()` schema on the route inherits
    // validation without per-adapter wiring. On failure the engine emits
    // `exchange:dropped` for telemetry and re-throws so the source's own
    // caller (e.g. a direct channel's `send`) sees the validation error.
    this.consumer.register(
      async (message, headers, parse, parseFailureMode) => {
        const exchange = this.buildExchange(message, headers);
        const inputSchemas = this.definition.discovery?.input;
        const hasInputSchema = !!inputSchemas?.body || !!inputSchemas?.headers;

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
            // parse step calls this hook once parse succeeds.
            if (hasInputSchema) {
              internals.applyValidation = (ex: Exchange) =>
                this.applyInputValidation(ex, inputSchemas);
            }
          }
        } else if (hasInputSchema) {
          // No parse: run validation eagerly (preserves existing behaviour).
          await this.applyInputValidation(exchange, inputSchemas);
        }

        return this.handler(exchange);
      },
    );

    let emitted = false;
    const onReady = () => {
      if (!emitted) {
        emitted = true;
        this.context.emit(`route:${this.definition.id}:started` as EventName, {
          route: this,
        });
      }
    };

    // If a test-time override is registered for this source adapter, route the
    // subscribe call through the mock's source behaviour instead of invoking
    // the real adapter. Falls through unchanged when no override matches.
    const sourceOverride = resolveAdapterOverride(
      this.definition.source,
      this.context,
    );
    const activeSource =
      sourceOverride && sourceOverride.source
        ? wrapSourceWithOverride(this.definition.source, sourceOverride)
        : this.definition.source;

    // Subscribe to the source and enqueue messages to the internal processing queue
    const meta = {
      routeId: this.definition.id,
      ...(this.definition.discovery
        ? { discovery: this.definition.discovery }
        : {}),
    };
    return activeSource.subscribe(
      this.context,
      (message, headers, parse, parseFailureMode) => {
        onReady(); // fallback: fire before first message if adapter never called it
        return this.messageChannel.enqueue({
          message,
          headers: headers ?? {},
          ...(parse
            ? {
                parse: parse as (raw: unknown) => unknown | Promise<unknown>,
                parseFailureMode: parseFailureMode ?? "fail",
              }
            : {}),
        });
      },
      this.abortController,
      onReady,
      meta,
    );
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
    this.messageChannel.clear();
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
              await this.applyOutputValidation(result.exchange, outputSchemas);
            } catch (err) {
              finalResult = await this.handleOutputValidationFailure(
                result.exchange,
                err,
                startTime,
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

    const userSteps = [...this.definition.steps];
    const initialSteps: Step<Adapter>[] = sourceParse
      ? [
          buildParseStep(sourceParse, sourceFailureMode, sourceValidate),
          ...userSteps,
        ]
      : userSteps;

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
      const { exchange, steps } = queue.shift()!;
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
        exchange.headers["routecraft.startedAt"] = childNow;
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

      // Update operation header for this step
      exchange.headers[HeadersKeys.OPERATION] = stepLabel;

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
          try {
            const forward = this.buildForward();
            const result = await this.definition.errorHandler(
              err,
              exchange,
              forward,
            );
            exchange.body = result;
            lastProcessedExchange = exchange;

            // Error handler recovered
            this.context.emit(
              `route:${this.definition.id}:error:caught` as EventName,
              {
                error: err,
                route: this,
                exchange,
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

    // Check if the root exchange was dropped (e.g. by a filter)
    if (exchange.headers["routecraft.dropped"] === true) {
      dropped = true;
    }

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
