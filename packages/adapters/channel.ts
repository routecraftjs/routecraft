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
  send(channel: string, exchange: Exchange): Promise<void>;

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

  async send(channel: string, exchange: Exchange): Promise<void> {
    console.debug(`Sending message to channel "${channel}"`, {
      exchangeId: exchange.id,
    });
    const subscribers = this.subscribers.get(channel) || [];
    await Promise.all(subscribers.map((subscriber) => subscriber(exchange)));
    console.debug(
      `Message sent to ${subscribers.length} subscribers on channel "${channel}"`,
      { exchangeId: exchange.id },
    );
  }

  subscribe(
    channel: string,
    handler: (exchange: Exchange) => Promise<void>,
  ): Promise<void> {
    console.info(`New subscription to channel "${channel}"`);
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, []);
    }
    this.subscribers.get(channel)?.push(handler);
    return Promise.resolve();
  }

  unsubscribe(channel: string): Promise<void> {
    console.info(`Unsubscribing from channel "${channel}"`);
    this.subscribers.delete(channel);
    return Promise.resolve();
  }
}

export interface ChannelAdapterOptions {
  channelFactory: (channel: string) => MessageChannel;
}

export class ChannelAdapter
  implements Source, Destination, MergedOptions<ChannelAdapterOptions>
{
  static readonly ADAPTER_CHANNEL_STORE =
    "routecraft.adapter.channel.store" as const;
  static readonly ADAPTER_CHANNEL_OPTIONS =
    "routecraft.adapter.channel.options" as const;

  private _channel: string;

  constructor(
    _channel: string,
    public options: Partial<ChannelAdapterOptions> = {},
  ) {
    this._channel = _channel;
  }

  private get channel(): string {
    return this._channel.replace(/[^a-zA-Z0-9]/g, "-");
  }

  subscribe(
    context: CraftContext,
    handler: (message: unknown, headers?: ExchangeHeaders) => Promise<void>,
    abortController: AbortController,
  ): Promise<void> {
    console.info(`Setting up subscription for channel "${this.channel}"`);
    const channel = this.messageChannel(context);
    if (abortController.signal.aborted) {
      console.debug(`Subscription aborted for channel "${this.channel}"`);
      return Promise.resolve();
    }

    // Return a promise that won't resolve until the subscription is cancelled
    return new Promise<void>((resolve) => {
      channel.subscribe(this.channel, async (exchange: Exchange) => {
        await handler(exchange.body, exchange.headers);
      });

      abortController.signal.addEventListener("abort", async () => {
        await channel.unsubscribe(this.channel);
        resolve();
      });
    });
  }

  private messageChannel(context: CraftContext): MessageChannel {
    let store = context.getStore(ChannelAdapter.ADAPTER_CHANNEL_STORE);

    // If the store is not set, create a new one
    if (!store) {
      store = new Map<string, MessageChannel>();
      context.setStore(ChannelAdapter.ADAPTER_CHANNEL_STORE, store);
    }

    // If the channel is not in the store, create a new one
    if (!store.has(this.channel)) {
      const mergedOptions = this.mergedOptions(context);
      store.set(this.channel, mergedOptions.channelFactory(this.channel));
    }

    return store.get(this.channel) as MessageChannel;
  }

  async send(exchange: Exchange & { context: CraftContext }): Promise<void> {
    console.debug(`Preparing to send message to channel "${this.channel}"`, {
      exchangeId: exchange.id,
    });
    const channel = this.messageChannel(exchange.context);
    return await channel.send(this.channel, exchange);
  }

  mergedOptions(context: CraftContext): ChannelAdapterOptions {
    const store = context.getStore(ChannelAdapter.ADAPTER_CHANNEL_OPTIONS);
    return {
      channelFactory: () => {
        return new InMemoryMessageChannel();
      },
      ...store,
      ...this.options,
    };
  }
}
