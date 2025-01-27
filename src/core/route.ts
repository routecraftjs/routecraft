import {
  type FromStepDefinition,
  type ProcessStepDefinition,
  type StepDefinition,
  type ToStepDefinition,
} from "./step.ts";
import { type CraftContext } from "./context.ts";
import { type Exchange, HeadersKeys, OperationType } from "./exchange.ts";

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
      throw new Error("Source step is required");
    }
  }

  subscribe(): Promise<() => void> {
    // Create a promise that resolves when subscription is done
    let resolveSubscription: (unsubscribe: () => void) => void;
    const subscriptionPromise = new Promise<() => void>((resolve) => {
      resolveSubscription = resolve;
    });

    // Subscribe to source and handle messages directly
    this.definition.source.subscribe(
      this.context,
      async (exchange: Exchange) => {
        // Process the exchange through the route
        await this.onMessage(exchange);
      },
    ).then((unsubscribe) => {
      // When subscription is complete, resolve with the unsubscribe function
      resolveSubscription(unsubscribe);
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
          throw new Error(`Unsupported operation type: ${step.operation}`);
      }
    }
  }
}
