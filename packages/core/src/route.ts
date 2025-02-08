import { type CraftContext } from "./context.ts";
import {
  DefaultExchange,
  type Exchange,
  type ExchangeHeaders,
  HeadersKeys,
  OperationType,
} from "./exchange.ts";
import { ErrorCode, RouteCraftError } from "./error.ts";
import { createLogger, type Logger } from "./logger.ts";
import { type StepDefinition } from "./step.ts";
import { type Adapter, type Source } from "./adapter.ts";

export type RouteDefinition = {
  readonly id: string;
  readonly source: Source & { operation: OperationType };
  readonly steps: StepDefinition<Adapter>[];
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

  constructor(
    public readonly context: CraftContext,
    public readonly definition: RouteDefinition,
    abortController?: AbortController,
  ) {
    this.assertNotAborted();
    this.abortController = abortController ?? new AbortController();
    this.logger = createLogger(this);
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  async start(): Promise<void> {
    this.assertNotAborted();
    this.logger.info(`Starting route "${this.definition.id}"`);

    const handlerWrapper = async (
      message: unknown,
      headers?: ExchangeHeaders,
    ) => {
      // Wrap the handler in a try/catch to catch individual message errors and log them as a RouteCraftError
      await this.handler(message, headers).catch((error) => {
        this.logger.warn(
          RouteCraftError.create(error, {
            code: ErrorCode.UNKNOWN_ERROR,
            message: `Error processing message for route "${this.definition.id}"`,
            cause: error,
          }),
          `Failed to process message on route "${this.definition.id}"`,
        );
      });
    };

    return await Promise.resolve(
      this.definition.source.subscribe(
        this.context,
        handlerWrapper,
        this.abortController,
      ),
    ).finally(() => {
      this.logger.info(`Route "${this.definition.id}" started successfully`);
      // If the route ends on its own, probably the source finished processing, trigger the abort
      this.abortController.abort("Route ended on its own");
    });
  }

  stop(): void {
    this.logger.info(`Stopping route "${this.definition.id}"`);
    this.abortController.abort("Route stop() called");
  }

  private buildExchange(message: unknown, headers?: ExchangeHeaders): Exchange {
    const partialExchange: Partial<Exchange> = {
      headers: {
        [HeadersKeys.CORRELATION_ID]: crypto.randomUUID(),
      },
    };

    return new DefaultExchange(this.context, {
      ...partialExchange,
      body: message,
      headers: {
        ...partialExchange.headers,
        ...headers,
        [HeadersKeys.ROUTE_ID]: this.definition.id,
        [HeadersKeys.OPERATION]: OperationType.FROM,
      },
    });
  }

  private async handler(
    message: unknown,
    headers?: ExchangeHeaders,
  ): Promise<void> {
    const initialExchange = this.buildExchange(message, headers);
    initialExchange.logger.debug(
      `Processing initial exchange ${initialExchange.id} on route "${this.definition.id}"`,
    );

    // Use a queue to process the steps in FIFO order.
    const queue: { exchange: Exchange; steps: StepDefinition<Adapter>[] }[] = [
      { exchange: initialExchange, steps: [...this.definition.steps] },
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
