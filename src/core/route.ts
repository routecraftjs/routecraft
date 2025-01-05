import {
  FromStepDefinition,
  ProcessStepDefinition,
  StepDefinition,
  ToStepDefinition,
} from "./step.ts";
import { CraftContext } from "./context.ts";
import {
  Exchange,
  ExchangeHeaders,
  HeadersKeys,
  OperationType,
} from "./exchange.ts";

export type RouteDefinition = {
  readonly id: string;
  readonly source: FromStepDefinition;
  readonly steps: StepDefinition[];
};

export class Route {
  constructor(
    public readonly context: CraftContext,
    public readonly definition: RouteDefinition,
  ) {
    if (!this.definition.source) {
      throw new Error("Source step is required");
    }
  }

  subscribe(): Promise<() => void> {
    const exchange = {
      id: crypto.randomUUID(),
      headers: {
        [HeadersKeys.ROUTE_ID]: this.definition.id,
        [HeadersKeys.OPERATION]: OperationType.FROM,
      },
      body: undefined,
    };

    const handler = (message: unknown, headers?: ExchangeHeaders) => {
      this.onMessage({
        ...exchange,
        headers: { ...exchange.headers, ...headers || {} },
        body: message,
      });
    };

    return this.definition.source.subscribe(handler);
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
