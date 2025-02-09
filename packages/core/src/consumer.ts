import { type ExchangeHeaders, type Exchange } from "./exchange.ts";
import { type CraftContext } from "./context.ts";
import { type MessageChannel } from "./channel.ts";
import { type RouteDefinition } from "./route.ts";
import { DefaultExchange, HeadersKeys, OperationType } from "./exchange.ts";

export type Message = {
  message: unknown;
  headers?: ExchangeHeaders;
};

export type BatchOptions = {
  /**
   * The size of the batch.
   */
  size?: number;
  /**
   * The timeout between batches.
   */
  time?: string;
  /**
   * The function to merge the produced messages.
   */
  merge?: (exchanges: { message: unknown; headers?: ExchangeHeaders }[]) => {
    message: unknown;
    headers?: ExchangeHeaders;
  };
};

export interface Consumer {
  context: CraftContext;
  channel: MessageChannel<Message>;
  definition: RouteDefinition;
  register(handler: (exchange: Exchange) => Promise<void>): void;
}

export class SimpleConsumer implements Consumer {
  constructor(
    public readonly context: CraftContext,
    public readonly definition: RouteDefinition,
    public readonly channel: MessageChannel<Message>,
  ) {}

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

  async register(
    handler: (exchange: Exchange) => Promise<void>,
  ): Promise<void> {
    this.channel.subscribe(this.context, "internal", async (message) => {
      const initialExchange = this.buildExchange(
        message.message,
        message.headers,
      );
      await handler(initialExchange);
    });
  }
}
