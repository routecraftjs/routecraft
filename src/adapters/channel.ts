import {
  type Adapter,
  CraftContext,
  type DefaultExchange,
  type Exchange,
  type ExchangeHeaders,
} from "@routecraft/core";

export interface MessageChannel {
  /** Send a message to the channel */
  send(channel: string, message: Exchange): Promise<void>;

  /** Subscribe to a channel */
  subscribe(
    channel: string,
    onMessage: (message: Exchange) => Promise<void>,
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
    onMessage: (message: Exchange) => Promise<void>,
  ): Promise<void> {
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, []);
    }
    this.subscribers.get(channel)?.push(onMessage);
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

export class ChannelAdapter implements Adapter {
  private static STORE_NAMESPACE: string = "routecraft.adapter.channel";
  private static defaultChannel = new InMemoryMessageChannel();
  private messageChannel: MessageChannel;

  constructor(
    private channel: string,
    options?: Partial<ChannelAdapterOptions>,
  ) {
    this.messageChannel = options?.messageChannel ??
      ChannelAdapter.defaultChannel;
  }

  private safeChannel(channel: string, context: CraftContext) {
    let store = context.getStore<MessageChannel>(
      ChannelAdapter.STORE_NAMESPACE,
    );

    // Initialize the store if it doesn't exist
    if (!store) {
      store = {};
      context.setStore<MessageChannel>(ChannelAdapter.STORE_NAMESPACE, store);
    }

    const safeChannelId = channel.replace(/[^a-zA-Z0-9]/g, "-");
    if (!store[safeChannelId]) {
      store[safeChannelId] = this.messageChannel;
    }

    return store[safeChannelId];
  }

  send(exchange: Exchange): Promise<void> {
    const { context } = exchange as DefaultExchange;
    const channel = this.safeChannel(this.channel, context);
    return channel.send(this.channel, exchange);
  }

  subscribe(
    context: CraftContext,
    handler: (message: unknown, headers?: ExchangeHeaders) => Promise<void>,
  ): Promise<() => void> {
    const channel = this.safeChannel(this.channel, context);

    channel.subscribe(this.channel, (exchange) => {
      return handler(exchange.body, exchange.headers);
    });

    return Promise.resolve(() => {
      channel.unsubscribe(this.channel);
    });
  }
}
