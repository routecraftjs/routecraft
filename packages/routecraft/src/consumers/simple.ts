import { CraftContext } from "../context.ts";
import { type RouteDefinition } from "../route.ts";
import { type ProcessingQueue, type Message, type Consumer } from "../types.ts";
import { type Exchange, type ExchangeHeaders } from "../exchange.ts";

export class SimpleConsumer implements Consumer<never> {
  constructor(
    public readonly context: CraftContext,
    public readonly definition: RouteDefinition,
    public readonly channel: ProcessingQueue<Message>,
    public readonly options: never,
  ) {}

  async register(
    handler: (message: unknown, headers?: ExchangeHeaders) => Promise<Exchange>,
  ): Promise<void> {
    this.channel.setHandler(async (message) => {
      return await handler(message.message, message.headers);
    });
  }
}
