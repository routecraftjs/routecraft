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
import { CraftErrors } from "./error.ts";

export type RouteDefinition = {
  readonly id: string;
  readonly source: FromStepDefinition;
  readonly steps: StepDefinition[];
};

export class Route {
  constructor(
    readonly context: CraftContext,
    readonly definition: RouteDefinition,
  ) {
    if (!this.definition.source) {
      throw CraftErrors.missingFromDefinition(this.definition.id);
    }
  }

  subscribe(): Promise<() => void> {
    // Create a promise that resolves when subscription is done
    let resolveSubscription: (unsubscribe: () => void) => void;
    const subscriptionPromise = new Promise<() => void>((resolve) => {
      resolveSubscription = resolve;
    });

    const partialExchange: Partial<Exchange> = {
      headers: {
        [HeadersKeys.CORRELATION_ID]: crypto.randomUUID(),
      },
    };

    // Subscribe to source and handle messages directly
    this.definition.source.subscribe(
      this.context,
      async (message: unknown, headers?: ExchangeHeaders) => {
        // Each message must have a new exhange
        const exchange = new DefaultExchange(this.context, {
          ...partialExchange,
          body: message,
          headers: {
            ...partialExchange.headers,
            ...headers,
            [HeadersKeys.ROUTE_ID]: this.definition.id,
            [HeadersKeys.OPERATION]: OperationType.FROM,
          },
        });

        // Process the exchange through the route
        await this.onMessage(exchange);
      },
    ).then((unsubscribe: () => void) => {
      // When subscription is complete, resolve with the unsubscribe function
      resolveSubscription(unsubscribe);
    }).catch((error) => {
      throw CraftErrors.subscriptionFailed(this.definition.id, error);
    });

    return subscriptionPromise;
  }

  private async onMessage(exchange: Exchange): Promise<void> {
    let currentExchange = exchange;

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
            const processor = step as ProcessStepDefinition;
            currentExchange = await Promise.resolve(
              processor.process(currentExchange),
            );
            break;
          }
          case OperationType.TO: {
            const destination = step as ToStepDefinition;
            await destination.send(currentExchange);
            break;
          }
          default:
            throw CraftErrors.invalidOperation(
              this.definition.id,
              step.operation,
            );
        }
      } catch (error) {
        switch (step.operation) {
          case OperationType.PROCESS:
            throw CraftErrors.processingError(this.definition.id, error);
          case OperationType.TO:
            throw CraftErrors.destinationError(this.definition.id, error);
          default:
            throw CraftErrors.processingError(this.definition.id, error);
        }
      }
    }
  }
}
