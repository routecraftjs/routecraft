import {
  type FromStepDefinition,
  type ProcessStepDefinition,
  type StepDefinition,
  type ToStepDefinition,
} from "./step.ts";
import { type CraftContext } from "./context.ts";
import {
  DefaultExchange,
  type Exchange,
  type ExchangeHeaders,
  HeadersKeys,
  OperationType,
} from "./exchange.ts";
import { ErrorCode, RouteCraftError } from "./error.ts";

export type RouteDefinition = {
  readonly id: string;
  readonly source: FromStepDefinition;
  readonly steps: StepDefinition[];
};

export interface Route {
  readonly context: CraftContext;
  readonly definition: RouteDefinition;
  readonly signal: AbortSignal;
  start(): Promise<void>;
  stop(): void;
}

export class DefaultRoute implements Route {
  private abortController: AbortController;

  constructor(
    public readonly context: CraftContext,
    public readonly definition: RouteDefinition,
    abortController?: AbortController,
  ) {
    this.assertNotAborted();
    this.abortController = abortController ?? new AbortController();
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  async start(): Promise<void> {
    this.assertNotAborted();
    console.info(`Starting route "${this.definition.id}"`);

    const handlerWrapper = async (
      message: unknown,
      headers?: ExchangeHeaders,
    ) => {
      // Wrap the handler in a try/catch to catch individual message errors and log them as a RouteCraftError
      await this.handler(message, headers).catch((error) => {
        console.warn(
          `Failed to process message on route "${this.definition.id}"`,
          {
            error: RouteCraftError.create(error, {
              code: ErrorCode.UNKNOWN_ERROR,
              message: `Error processing message for route "${this.definition.id}"`,
              cause: error,
            }),
          },
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
      console.info(`Route "${this.definition.id}" started successfully`);
      // If the route ends on its own, probably the source finished processing, trigger the abort
      this.abortController.abort("Route ended on its own");
    });
  }

  stop(): void {
    console.info(`Stopping route "${this.definition.id}"`);
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
    let currentExchange = this.buildExchange(message, headers);
    console.debug(
      `Processing exchange ${currentExchange.id} on route "${this.definition.id}"`,
    );

    for (const step of this.definition.steps) {
      // Update the operation type in headers for the current step
      currentExchange = {
        ...currentExchange,
        headers: {
          ...currentExchange.headers,
          [HeadersKeys.OPERATION]: step.operation,
        },
      };

      try {
        switch (step.operation) {
          case OperationType.PROCESS: {
            console.debug(`Processing step on exchange ${currentExchange.id}`);
            const processor = step as ProcessStepDefinition;
            currentExchange = await Promise.resolve(
              processor.process(currentExchange),
            );
            break;
          }
          case OperationType.TO: {
            console.debug(
              `Sending exchange ${currentExchange.id} to destination`,
            );
            const destination = step as ToStepDefinition;
            await destination.send(currentExchange);
            break;
          }
          default:
            this.assertOperation(step.operation);
        }
      } catch (error) {
        console.error(
          `Step ${step.operation} failed for exchange ${currentExchange.id}`,
          error,
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
