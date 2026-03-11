import { randomUUID } from "node:crypto";
import { type CraftContext } from "./context.ts";
import {
  type Exchange,
  HeadersKeys,
  OperationType,
  type ExchangeHeaders,
  DefaultExchange,
  EXCHANGE_INTERNALS,
} from "./exchange.ts";

/**
 * Function that forwards a payload to another route via the direct adapter and returns its result.
 *
 * @param routeId - The target route's direct endpoint id
 * @param payload - The data to send
 * @returns The result of the target route's pipeline
 */
export type ForwardFn = (routeId: string, payload: unknown) => Promise<unknown>;

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
import { BRAND, INTERNALS_KEY, setBrand } from "./brand.ts";
import { rcError, RouteCraftError, RC } from "./error.ts";
import { isRouteCraftError } from "./brand.ts";
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
        this.context.emit("route:stopping", {
          route: this,
          reason: (event as unknown as { reason?: unknown })?.reason,
        });
      } finally {
        this.context.emit("route:stopped", { route: this });
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
   * Track a background task (e.g. tap) for this route.
   * @internal
   */
  trackTask(promise: Promise<unknown>): void {
    const handledPromise = promise.catch((err: unknown) => {
      const msg = isRouteCraftError(err)
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
   * @throws {RouteCraftError} If the route has been aborted
   */
  async start(): Promise<void> {
    this.assertNotAborted();
    // Lifecycle log is emitted only by context (one log per event).

    // Start consuming messages from the internal processing queue
    this.consumer.register((message, headers) => {
      return this.handler(this.buildExchange(message, headers));
    });

    let emitted = false;
    const onReady = () => {
      if (!emitted) {
        emitted = true;
        this.context.emit("route:started", { route: this });
      }
    };

    // Subscribe to the source and enqueue messages to the internal processing queue
    return this.definition.source.subscribe(
      this.context,
      (message, headers) => {
        onReady(); // fallback: fire before first message if adapter never called it
        return this.messageChannel.enqueue({
          message,
          headers: headers ?? {},
        });
      },
      this.abortController,
      onReady,
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
      exchangeId: correlationId,
      correlationId,
    });

    // Run steps (tap adds tasks via route.trackTask)
    const handlerPromise = this.runSteps(exchange, startTime).then((result) => {
      const duration = Date.now() - startTime;
      const correlationId = exchange.headers[
        HeadersKeys.CORRELATION_ID
      ] as string;
      this.context.emit(
        `route:${this.definition.id}:exchange:completed` as const,
        {
          routeId: this.definition.id,
          exchangeId: correlationId,
          correlationId,
          duration,
        },
      );
      return result;
    });

    this.inFlight.add(handlerPromise);
    handlerPromise.finally(() => this.inFlight.delete(handlerPromise));

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
  ): Promise<Exchange> {
    const queue: { exchange: Exchange; steps: Step<Adapter>[] }[] = [
      { exchange: exchange, steps: [...this.definition.steps] },
    ];

    let lastProcessedExchange: Exchange = exchange;

    while (queue.length > 0) {
      const { exchange, steps } = queue.shift()!;
      if (steps.length === 0) {
        lastProcessedExchange = exchange;
        continue;
      }

      const [step, ...remainingSteps] = steps;

      // Update operation header for this step
      exchange.headers[HeadersKeys.OPERATION] = step.operation;

      const adapterLabel = getAdapterLabel(step.adapter);
      exchange.logger.debug(
        {
          operation: step.operation,
          ...(adapterLabel ? { adapter: adapterLabel } : {}),
        },
        "Processing step",
      );

      const stepStartTime = Date.now();
      const correlationId = exchange.headers[
        HeadersKeys.CORRELATION_ID
      ] as string;

      // Emit step:started event
      this.context.emit(`route:${this.definition.id}:step:started` as const, {
        routeId: this.definition.id,
        exchangeId: correlationId,
        correlationId,
        operation: step.operation,
        ...(adapterLabel ? { adapter: adapterLabel } : {}),
      });

      try {
        await step.execute(exchange, remainingSteps, queue);

        // Emit step:completed event
        const stepDuration = Date.now() - stepStartTime;
        const correlationId = exchange.headers[
          HeadersKeys.CORRELATION_ID
        ] as string;
        this.context.emit(
          `route:${this.definition.id}:step:completed` as const,
          {
            routeId: this.definition.id,
            exchangeId: correlationId,
            correlationId,
            operation: step.operation,
            ...(adapterLabel ? { adapter: adapterLabel } : {}),
            duration: stepDuration,
          },
        );
      } catch (error) {
        const err = this.processError(step.operation, error);
        const correlationId = exchange.headers[
          HeadersKeys.CORRELATION_ID
        ] as string;
        const duration = Date.now() - startTime;

        if (this.definition.errorHandler) {
          // Emit error:invoked event
          this.context.emit(
            `route:${this.definition.id}:operation:error:invoked` as const,
            {
              routeId: this.definition.id,
              exchangeId: correlationId,
              correlationId,
              originalError: err,
              failedOperation: step.operation,
            },
          );

          try {
            const forward = this.buildForward();
            const result = await this.definition.errorHandler(
              err,
              exchange,
              forward,
            );
            exchange.body = result;
            lastProcessedExchange = exchange;

            this.context.emit(
              `route:${this.definition.id}:operation:error:recovered` as const,
              {
                routeId: this.definition.id,
                exchangeId: correlationId,
                correlationId,
                originalError: err,
                failedOperation: step.operation,
                recoveryStrategy: "errorHandler",
              },
            );
          } catch (handlerError) {
            const handlerErr = this.processError(step.operation, handlerError);
            exchange.logger.error(
              { operation: step.operation, err: handlerErr },
              "Error handler itself threw",
            );
            this.context.emit("error", {
              error: handlerErr,
              route: this,
              exchange,
            });
            this.context.emit(
              `route:${this.definition.id}:operation:error:failed` as const,
              {
                routeId: this.definition.id,
                exchangeId: correlationId,
                correlationId,
                originalError: err,
                failedOperation: step.operation,
                recoveryStrategy: "errorHandler",
              },
            );
            this.context.emit(
              `route:${this.definition.id}:exchange:failed` as const,
              {
                routeId: this.definition.id,
                exchangeId: correlationId,
                correlationId,
                duration,
                error: handlerErr,
              },
            );
          }

          // Pipeline does not resume after error handler (success or failure)
          return lastProcessedExchange;
        }

        // Default behavior: log, emit, swallow
        exchange.logger.error(
          {
            operation: step.operation,
            ...(adapterLabel ? { adapter: adapterLabel } : {}),
            err,
          },
          err.meta.message,
        );
        this.context.emit("error", {
          error: err,
          route: this,
          exchange: exchange,
        });
        this.context.emit(
          `route:${this.definition.id}:exchange:failed` as const,
          {
            routeId: this.definition.id,
            exchangeId: correlationId,
            correlationId,
            duration,
            error: err,
          },
        );

        // Don't re-throw - error is fully handled via events and logging
        // Re-throwing would create unhandled rejections
        // Do NOT return here: the while loop continues so other queue items (e.g. split children) are processed
      }
    }
    return lastProcessedExchange;
  }

  /**
   * Build a forward function that sends a payload to another route via the direct adapter.
   *
   * @returns A forward function
   * @private
   */
  private buildForward(): (
    routeId: string,
    payload: unknown,
  ) => Promise<unknown> {
    return async (routeId: string, payload: unknown): Promise<unknown> => {
      const { getDirectChannel, sanitizeEndpoint } =
        await import("./adapters/direct/shared.ts");
      const endpoint = sanitizeEndpoint(routeId);
      const channel = getDirectChannel(this.context, endpoint, {});
      const forwardExchange = this.buildExchange(payload);
      const result = await channel.send(endpoint, forwardExchange);
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
   * @throws {RouteCraftError} If the route has been aborted
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
   * Normalize an operation error into a RouteCraftError.
   * If the error is already a RouteCraftError, it is returned unchanged.
   *
   * @param _operation - The operation that caused the error (for logging)
   * @param error - The thrown value (Error or RouteCraftError)
   * @returns A RouteCraftError (existing or RC5001-wrapped)
   * @private
   */
  private processError(
    _operation: OperationType,
    error: unknown,
  ): RouteCraftError {
    if (isRouteCraftError(error)) {
      return error as RouteCraftError;
    }
    const msg = error instanceof Error ? error.message : String(error);
    return rcError("RC5001", error, { message: msg });
  }
}
