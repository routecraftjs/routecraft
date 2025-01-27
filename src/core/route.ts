import {
  type FromStepDefinition,
  type ProcessStepDefinition,
  type StepDefinition,
  type ToStepDefinition,
} from "./step.ts";
import { type CraftContext } from "./context.ts";
import { type Exchange, HeadersKeys, OperationType } from "./exchange.ts";
import { type MessageChannel } from "./channel.ts";
import { type Message } from "./adapter.ts";

export type RouteDefinition = {
  readonly id: string;
  readonly source: FromStepDefinition;
  readonly steps: StepDefinition[];
};

export class Route {
  constructor(
    readonly context: CraftContext,
    readonly definition: RouteDefinition,
    readonly messageChannel: MessageChannel<Message>,
  ) {
    if (!this.definition.source) {
      throw new Error("Source step is required");
    }
  }

  subscribe(): Promise<() => void> {
    // Start consuming messages from the message channel
    const consumeMessages = async () => {
      while (true) {
        const message = await this.messageChannel.consume();
        if (message) {
          // Each new message is a new exchange
          await this.onMessage({
            id: crypto.randomUUID(),
            body: message.body,
            headers: message.headers,
            context: this.context,
          });

          // Stop consuming if this was marked as the final message
          if (message.headers?.[HeadersKeys.FINAL_MESSAGE]) {
            break;
          }
        }
        // Small delay to prevent tight loop
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };

    // Create a promise that resolves when both subscription and message processing are done
    let resolveSubscription: (unsubscribe: () => void) => void;
    const subscriptionPromise = new Promise<() => void>((resolve) => {
      resolveSubscription = resolve;
    });

    // Start the subscription process
    this.definition.source.subscribe(
      this.context,
      async (exchange: Exchange) => {
        const { context: _, ...messageExchange } = exchange;
        await this.messageChannel.publish(messageExchange);
      },
    ).then((unsubscribe) => {
      // Once subscribed, start consuming messages
      consumeMessages().then(() => {
        // When all messages are consumed, resolve with the unsubscribe function
        resolveSubscription(unsubscribe);
      });
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
