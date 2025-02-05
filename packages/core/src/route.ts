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
import { type StepDefinition } from "./adapter.ts";

export type RouteDefinition = {
  readonly id: string;
  readonly source: StepDefinition<unknown, "from">;
  readonly steps: StepDefinition[];
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
        [HeadersKeys.ADAPTER]: this.definition.source.adapterId,
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

    // Use a stack to process the steps in a single method.
    const stack: { exchange: Exchange; steps: StepDefinition[] }[] = [
      { exchange: initialExchange, steps: [...this.definition.steps] },
    ];

    while (stack.length > 0) {
      const { exchange, steps } = stack.pop()!;
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
        switch (step.operation) {
          case OperationType.PROCESS: {
            const processor = step as StepDefinition<unknown, "process">;
            const newExchange = await Promise.resolve(
              processor.process(updatedExchange),
            );
            // Push the result with the remaining steps back on the stack.
            stack.push({ exchange: newExchange, steps: remainingSteps });
            break;
          }
          case OperationType.TO: {
            const destination = step as StepDefinition<unknown, "to">;
            await destination.send(updatedExchange);
            break;
          }
          case OperationType.SPLIT: {
            const splitter = step as StepDefinition<unknown, "split">;
            const splits = await Promise.resolve(
              splitter.split(updatedExchange),
            );
            // For each split exchange, assign a new ID while preserving
            // the correlation and other header values.
            splits.forEach((exch) => {
              const newExchange = { ...exch, id: crypto.randomUUID() };
              stack.push({ exchange: newExchange, steps: remainingSteps });
            });
            break;
          }
          default:
            this.assertOperation(step.operation);
        }
      } catch (error) {
        updatedExchange.logger.error(
          error,
          `Step ${step.operation} failed for exchange ${updatedExchange.id}`,
        );
        switch (step.operation) {
          case OperationType.PROCESS:
            throw this.processError(
              step.operation,
              ErrorCode.PROCESS_ERROR,
              error,
            );
          case OperationType.TO:
            throw this.processError(step.operation, ErrorCode.TO_ERROR, error);
          case OperationType.SPLIT:
            throw this.processError(
              step.operation,
              ErrorCode.SPLIT_ERROR,
              error,
            );
          default:
            throw new RouteCraftError({
              code: ErrorCode.UNKNOWN_ERROR,
              message: `Unknown error for route "${this.definition.id}"`,
              suggestion:
                "Check the operation configuration and ensure it is valid",
              cause: error,
            });
        }
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

  private assertOperation(operation: OperationType): void {
    if (!Object.values(OperationType).includes(operation)) {
      throw new RouteCraftError({
        code: ErrorCode.INVALID_OPERATION,
        message: `Invalid operation type "${operation}" for route "${this.definition.id}"`,
        suggestion: "Ensure the operation is valid",
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
