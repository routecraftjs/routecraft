import {
  type CraftContext,
  type Destination,
  type Exchange,
  type ExchangeHeaders,
  type MergedOptions,
  type Source,
} from "@routecraft/core";

// Extend the store registry with channel adapter types
declare module "@routecraft/core" {
  interface StoreRegistry {
    [ChannelAdapter.ADAPTER_CHANNEL_STORE]: Map<string, MessageChannel>;
    [ChannelAdapter.ADAPTER_CHANNEL_OPTIONS]: Partial<ChannelAdapterOptions>;
  }
}

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

export class InMemoryMessageChannel implements MessageChannel {
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
  channelFactory: (channel: string) => MessageChannel;
};

export class ChannelAdapter
  implements Source, Destination, MergedOptions<ChannelAdapterOptions> {
  static readonly ADAPTER_CHANNEL_STORE =
    "routecraft.adapter.channel.store" as const;
  static readonly ADAPTER_CHANNEL_OPTIONS =
    "routecraft.adapter.channel.options" as const;

  private channel: string;

  constructor(
    channel: string,
    public options: Partial<ChannelAdapterOptions> = {},
  ) {
    this.channel = channel;
  }

  private getSafeChannelId(): string {
    return this.channel.replace(/[^a-zA-Z0-9]/g, "-");
  }

  private getMessageChannel(context: CraftContext): MessageChannel | undefined {
    const safeChannelId = this.getSafeChannelId();
    let store = context.getStore(ChannelAdapter.ADAPTER_CHANNEL_STORE);

    if (!store) {
      store = new Map<string, MessageChannel>();
      context.setStore(ChannelAdapter.ADAPTER_CHANNEL_STORE, store);
    }

    if (!store.has(safeChannelId)) {
      const mergedOptions = this.mergedOptions(context);
      store.set(safeChannelId, mergedOptions.channelFactory(safeChannelId));
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

  mergedOptions(context: CraftContext): ChannelAdapterOptions {
    const store = context.getStore(ChannelAdapter.ADAPTER_CHANNEL_OPTIONS);
    return {
      channelFactory: (_channel) => {
        return new InMemoryMessageChannel();
      },
      ...store,
      ...this.options,
    };
  }
}
