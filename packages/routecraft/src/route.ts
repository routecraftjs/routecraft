import { type CraftContext } from "./context.ts";
import {
  type Exchange,
  HeadersKeys,
  OperationType,
  type ExchangeHeaders,
  DefaultExchange,
  EXCHANGE_INTERNALS,
} from "./exchange.ts";
import { error as rcError, RouteCraftError, RC } from "./error.ts";
import { createLogger, type Logger } from "./logger.ts";
import { type Source } from "./operations/from.ts";
import {
  type Adapter,
  type Step,
  type Consumer,
  type ConsumerType,
  type Message,
  type ProcessingQueue,
} from "./types.ts";
import { InMemoryProcessingQueue } from "./queue.ts";

/**
 * Defines the configuration for a route including its source, steps, and consumer.
 *
 * A route definition describes how data flows from a source through processing steps
 * to one or more destinations.
 *
 * @template T The type of data produced by the source
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
};

/**
 * Represents a runnable route that processes data.
 *
 * Routes handle the flow of data from a source through processing steps
 * and can be started and stopped.
 */
export interface Route {
  /** The context this route belongs to */
  readonly context: CraftContext;

  /** The route's configuration */
  readonly definition: RouteDefinition;

  /** Signal that indicates when the route has been aborted */
  readonly signal: AbortSignal;

  /** Logger for this route */
  logger: Logger;

  /**
   * Start processing data on this route.
   * @returns A promise that resolves when the route has started
   */
  start(): Promise<void>;

  /**
   * Stop processing data on this route.
   */
  stop(): void;

  /**
   * Wait for all in-flight handlers (and their background tasks) to complete.
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
 * Handles the lifecycle of a route, managing the message flow from
 * the source through the defined steps.
 */
export class DefaultRoute implements Route {
  /** Controls aborting the route's operations */
  private abortController: AbortController;

  /** Logger for this route */
  public readonly logger: Logger;

  /** Internal queue for passing messages between the source and consumer */
  private messageChannel: ProcessingQueue<Message>;

  /** Processes messages from the message channel */
  private consumer: Consumer;

  /** In-flight handler promises (for drain) */
  private inFlightHandlers = new Set<Promise<Exchange>>();

  /** Background tasks (e.g. tap) tracked at route level */
  private tasks = new Set<Promise<unknown>>();

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
    this.assertNotAborted();
    this.abortController = abortController ?? new AbortController();
    this.logger = createLogger(this);
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
        this.context.emit("routeStopping", {
          route: this,
          reason: (event as unknown as { reason?: unknown })?.reason,
        });
      } finally {
        this.context.emit("routeStopped", { route: this });
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
        [HeadersKeys.CORRELATION_ID]: crypto.randomUUID(),
        [HeadersKeys.ROUTE_ID]: this.definition.id,
        [HeadersKeys.OPERATION]: OperationType.FROM,
      },
    });

    // Add route to internals so steps like tap can access it
    const internals = EXCHANGE_INTERNALS.get(exchange);
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
    this.tasks.add(promise);
    promise.finally(() => this.tasks.delete(promise));
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
    this.logger.debug(`Starting route "${this.definition.id}"`);

    // Start consuming messages from the internal processing queue
    this.consumer.register((message, headers) => {
      return this.handler(this.buildExchange(message, headers));
    });

    // Signal that the route has started successfully (consumer registered)
    this.context.emit("routeStarted", { route: this });

    // Subscribe to the source and enqueue messages to the internal processing queue
    return this.definition.source.subscribe(
      this.context,
      (message, headers) => {
        return this.messageChannel.enqueue({
          message,
          headers: headers ?? {},
        });
      },
      this.abortController,
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
    this.logger.debug(`Stopping route "${this.definition.id}"`);
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
    exchange.logger.debug(
      `Processing initial exchange ${exchange.id} on route "${this.definition.id}"`,
    );

    // Run steps (tap adds tasks via route.trackTask)
    const handlerPromise = this.runSteps(exchange);

    this.inFlightHandlers.add(handlerPromise);
    handlerPromise.finally(() => this.inFlightHandlers.delete(handlerPromise));

    return handlerPromise;
  }

  /**
   * Run the step loop for an exchange.
   *
   * @param exchange The initial exchange to process
   * @returns The last processed exchange
   * @private
   */
  private async runSteps(exchange: Exchange): Promise<Exchange> {
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

      exchange.logger.debug(
        `Processing step ${step.operation} on exchange ${exchange.id}`,
      );

      try {
        await step.execute(exchange, remainingSteps, queue);
      } catch (error) {
        const err = this.processError(step.operation, error);
        exchange.logger.warn(
          err,
          `Step ${step.operation} failed for exchange ${exchange.id}`,
        );
        this.context.emit("error", {
          error: err,
          route: this,
          exchange: exchange,
        });
      }
    }
    return lastProcessedExchange;
  }

  /**
   * Wait for all in-flight handlers and background tasks to complete.
   * Loops until no new handlers are added (drains consumer queue).
   */
  async drain(): Promise<void> {
    this.logger.debug(
      `Draining route: ${this.inFlightHandlers.size} handlers, ${this.tasks.size} tasks in flight`,
    );
    while (this.inFlightHandlers.size > 0 || this.tasks.size > 0) {
      const currentHandlers = [...this.inFlightHandlers];
      const currentTasks = [...this.tasks];
      await Promise.all([...currentHandlers, ...currentTasks]);
    }
    this.logger.debug("Route drained");
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
   * Create a RouteCraftError from an operation error.
   * If the error is already a RouteCraftError, preserve it.
   *
   * @param operation The operation that caused the error
   * @param code The error code
   * @param error The original error
   * @returns A formatted RouteCraftError
   * @private
   */
  private processError(
    operation: OperationType,
    error: unknown,
  ): RouteCraftError {
    // If already a RouteCraftError, preserve the original error code
    if (error instanceof RouteCraftError) {
      return error;
    }
    const rc = "RC5002" as const; // Processing step threw
    return rcError(rc, error, {
      message: `${RC[rc].message}: op=${operation} route=${this.definition.id}`,
    });
  }

  /**
   * Get the documentation URL for operation error codes.
   *
   * @param code The error code
   * @returns The documentation URL
   * @private
   */
  // Docs URL is sourced from the RC registry; no per-operation mapping required.
}
