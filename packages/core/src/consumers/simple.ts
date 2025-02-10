import { CraftContext } from "../context.ts";
import { type RouteDefinition } from "../route.ts";
import { type MessageChannel, type Message, type Consumer } from "../types.ts";
import { type ExchangeHeaders } from "../exchange.ts";

export class SimpleConsumer implements Consumer<never> {
  constructor(
    public readonly context: CraftContext,
    public readonly definition: RouteDefinition,
    public readonly channel: MessageChannel<Message>,
    public readonly options: never,
  ) {}

  async register(
    handler: (message: unknown, headers?: ExchangeHeaders) => Promise<void>,
  ): Promise<void> {
    this.channel.subscribe(this.context, "internal", async (message) => {
      await handler(message.message, message.headers);
    });
  }
}
