import { type CraftContext } from "./context.ts";
import {
  type Exchange,
  HeadersKeys,
  OperationType,
  type ExchangeHeaders,
  DefaultExchange,
} from "./exchange.ts";
import { ErrorCode, RouteCraftError } from "./error.ts";
import { createLogger, type Logger } from "./logger.ts";
import { type Source } from "./operations/from.ts";
import {
  type Adapter,
  type StepDefinition,
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
  readonly steps: StepDefinition<Adapter>[];

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
    return new DefaultExchange(this.context, {
      body: message,
      headers: {
        ...headers,
        [HeadersKeys.CORRELATION_ID]: crypto.randomUUID(),
        [HeadersKeys.ROUTE_ID]: this.definition.id,
        [HeadersKeys.OPERATION]: OperationType.FROM,
      },
    });
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
    this.logger.info(`Starting route "${this.definition.id}"`);

    // Start consuming messages from the internal processing queue
    this.consumer.register((message, headers) => {
      return this.handler(this.buildExchange(message, headers));
    });

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
    this.logger.info(`Stopping route "${this.definition.id}"`);
    this.messageChannel.clear();
    this.abortController.abort("Route stop() called");
  }

  /**
   * Process an exchange through the route's steps.
   *
   * This is the main processing logic that:
   * 1. Takes an initial exchange from the source
   * 2. Processes it through each step in sequence
   * 3. Handles errors that occur during processing
   *
   * @param exchange The initial exchange to process
   * @returns A promise that resolves when processing is complete
   * @private
   */
  private async handler(exchange: Exchange): Promise<Exchange> {
    exchange.logger.debug(
      `Processing initial exchange ${exchange.id} on route "${this.definition.id}"`,
    );

    // Use a queue to process the steps in FIFO order.
    const queue: { exchange: Exchange; steps: StepDefinition<Adapter>[] }[] = [
      { exchange: exchange, steps: [...this.definition.steps] },
    ];

    let lastProcessedExchange: Exchange = exchange;

    while (queue.length > 0) {
      const { exchange, steps } = queue.shift()!;
      if (steps.length === 0) {
        // No more steps; this is a completed exchange for this branch.
        lastProcessedExchange = exchange;
        continue;
      }

      const [step, ...remainingSteps] = steps;

      // Update operation type in headers for the current step
      const updatedExchange: Exchange = {
        ...exchange,
        headers: {
          ...exchange.headers,
          [HeadersKeys.OPERATION]: step.operation,
        },
      };

      updatedExchange.logger.debug(
        `Processing step ${step.operation} on exchange ${updatedExchange.id}`,
      );

      try {
        await step.execute(updatedExchange, remainingSteps, queue);
      } catch (error) {
        const err = this.processError(
          step.operation,
          ErrorCode.PROCESS_ERROR,
          error,
        );
        updatedExchange.logger.warn(
          err,
          `Step ${step.operation} failed for exchange ${updatedExchange.id}`,
        );
      }
    }
    return lastProcessedExchange;
  }

  /**
   * Check if the route has been aborted, and throw an error if it has.
   *
   * @throws {RouteCraftError} If the route has been aborted
   * @private
   */
  private assertNotAborted(): void {
    if (this.abortController?.signal.aborted) {
      throw new RouteCraftError({
        code: ErrorCode.ROUTE_COULD_NOT_START,
        message: `Route "${this.definition.id}" cannot be started because it was aborted`,
        suggestion:
          "Ensure the abortController is not aborted before starting the route",
      });
    }
  }

  /**
   * Create a RouteCraftError from an operation error.
   *
   * @param operation The operation that caused the error
   * @param code The error code
   * @param error The original error
   * @returns A formatted RouteCraftError
   * @private
   */
  private processError(
    operation: OperationType,
    code: ErrorCode,
    error: unknown,
  ): RouteCraftError {
    return new RouteCraftError({
      code: code,
      message: `Operation "${operation}" failed for route "${this.definition.id}"`,
      suggestion: "Check the operation configuration and ensure it is valid",
      cause: RouteCraftError.parse(error).error,
    });
  }
}
