import { Adapter } from "../core/adapter.ts";
import { CraftContext } from "../core/context.ts";
import { Exchange, ExchangeHeaders } from "../core/exchange.ts";

export interface MessageChannel {
  /** Send a message to the channel */
  send(channel: string, message: Exchange): Promise<void>;

  /** Subscribe to a channel */
  subscribe(
    channel: string,
    handler: (exchange: Exchange) => Promise<void>,
  ): Promise<void>;

  /** Unsubscribe from a channel */
  unsubscribe(channel: string): Promise<void>;
}

class InMemoryMessageChannel implements MessageChannel {
  private subscribers: Map<string, ((message: Exchange) => Promise<void>)[]> =
    new Map();

  async send(channel: string, message: Exchange): Promise<void> {
    const subscribers = this.subscribers.get(channel) || [];
    await Promise.all(subscribers.map((subscriber) => subscriber(message)));
  }

  subscribe(
    channel: string,
    handler: (message: Exchange) => Promise<void>,
  ): Promise<void> {
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, []);
    }
    this.subscribers.get(channel)?.push(handler);
    return Promise.resolve();
  }

  unsubscribe(channel: string): Promise<void> {
    this.subscribers.delete(channel);
    return Promise.resolve();
  }
}

export type ChannelAdapterOptions = {
  messageChannel: MessageChannel;
};

export class ChannelAdapter implements Adapter<unknown> {
  static readonly ADAPTER_CHANNEL_STORE = "routecraft.adapter.channel.store";

  private channel: string;
  private messageChannel: MessageChannel;

  constructor(channel: string, options?: Partial<ChannelAdapterOptions>) {
    this.channel = channel;
    this.messageChannel = options?.messageChannel ??
      new InMemoryMessageChannel();
  }

  private getSafeChannelId(): string {
    return this.channel.replace(/[^a-zA-Z0-9]/g, "-");
  }

  private getMessageChannel(context: CraftContext): MessageChannel | undefined {
    const safeChannelId = this.getSafeChannelId();
    let store = context.getStore<Map<string, MessageChannel>>(
      ChannelAdapter.ADAPTER_CHANNEL_STORE,
    );

    if (!store) {
      store = new Map<string, MessageChannel>();
      context.setStore(ChannelAdapter.ADAPTER_CHANNEL_STORE, store);
    }

    if (!store.get(safeChannelId)) {
      store.set(safeChannelId, this.messageChannel);
    }

    return store.get(safeChannelId);
  }

  async send(exchange: Exchange & { context: CraftContext }): Promise<void> {
    const channel = this.getMessageChannel(exchange.context);
    if (!channel) {
      throw new Error("Channel not found");
    }
    return await channel.send(this.channel, exchange);
  }

  subscribe(
    context: CraftContext,
    handler: (message: unknown, headers?: ExchangeHeaders) => Promise<void>,
  ): Promise<() => void> {
    const channel = this.getMessageChannel(context);
    if (!channel) {
      throw new Error("Channel not found");
    }

    channel.subscribe(this.channel, async (exchange: Exchange) => {
      await handler(exchange.body, exchange.headers);
    });

    return Promise.resolve(async () => {
      await channel.unsubscribe(this.channel);
    });
  }
}
