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
  type MessageChannel,
  type Consumer,
  type ConsumerType,
  type Message,
} from "./types.ts";
import { InMemoryMessageChannel } from "./channels/memory.ts";

export type RouteDefinition<T = unknown> = {
  readonly id: string;
  readonly source: Source<T>;
  readonly steps: StepDefinition<Adapter>[];
  readonly consumer: {
    type: ConsumerType<Consumer>;
    options: unknown;
  };
};

export interface Route {
  readonly context: CraftContext;
  readonly definition: RouteDefinition;
  readonly signal: AbortSignal;
  start(): Promise<void>;
  stop(): void;
  logger: Logger;
}

export class DefaultRoute implements Route {
  private abortController: AbortController;
  public readonly logger: Logger;
  private messageChannel: MessageChannel<Message>;
  private consumer: Consumer;

  constructor(
    public readonly context: CraftContext,
    public readonly definition: RouteDefinition,
    abortController?: AbortController,
  ) {
    this.assertNotAborted();
    this.abortController = abortController ?? new AbortController();
    this.logger = createLogger(this);
    this.messageChannel = new InMemoryMessageChannel<Message>();
    this.consumer = new this.definition.consumer.type(
      this.context,
      this.definition,
      this.messageChannel,
      this.definition.consumer.options,
    );
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

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

  async start(): Promise<void> {
    this.assertNotAborted();
    this.logger.info(`Starting route "${this.definition.id}"`);

    // Start consuming messages from the message channel
    this.consumer.register((message, headers) => {
      return Promise.resolve(
        this.handler(this.buildExchange(message, headers)),
      );
    });

    // Subscribe to the source and send messages to the message channel
    return this.definition.source.subscribe(
      this.context,
      (message, headers) => {
        return this.messageChannel.send("internal", {
          message,
          headers: headers ?? {},
        });
      },
      this.abortController,
    );
  }

  stop(): void {
    this.logger.info(`Stopping route "${this.definition.id}"`);
    this.messageChannel.unsubscribe(this.context, "internal");
    this.abortController.abort("Route stop() called");
  }

  private async handler(exchange: Exchange): Promise<void> {
    exchange.logger.debug(
      `Processing initial exchange ${exchange.id} on route "${this.definition.id}"`,
    );

    // Use a queue to process the steps in FIFO order.
    const queue: { exchange: Exchange; steps: StepDefinition<Adapter>[] }[] = [
      { exchange: exchange, steps: [...this.definition.steps] },
    ];

    while (queue.length > 0) {
      const { exchange, steps } = queue.shift()!;
      if (steps.length === 0) continue;

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
  }

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
