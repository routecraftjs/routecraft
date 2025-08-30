import {
  type ExchangeHeaders,
  type Exchange,
  type DefaultExchange,
} from "../exchange";
import { type Source } from "../operations/from";
import { CraftContext, type MergedOptions } from "../context";
import { type Destination } from "../operations/to";

export type ChannelType<T extends MessageChannel> = new (channel: string) => T;

export interface MessageChannel<T = unknown> {
  send(channel: string, message: T): Promise<void>;
  subscribe(
    context: CraftContext,
    channel: string,
    handler: (message: T) => Promise<void>,
  ): Promise<void>;
  unsubscribe(context: CraftContext, channel: string): Promise<void>;
}

declare module "@routecraftjs/routecraft" {
  interface StoreRegistry {
    [ChannelAdapter.ADAPTER_CHANNEL_STORE]: Map<
      string,
      MessageChannel<Exchange>
    >;
    [ChannelAdapter.ADAPTER_CHANNEL_OPTIONS]: Partial<ChannelAdapterOptions>;
  }
}

export interface ChannelAdapterOptions {
  channelType?: ChannelType<MessageChannel>;
}

export class ChannelAdapter<T = unknown>
  implements Source<T>, Destination<T>, MergedOptions<ChannelAdapterOptions>
{
  readonly adapterId = "routecraft.adapter.channel";
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
    handler: (message: T, headers?: ExchangeHeaders) => Promise<void>,
    abortController: AbortController,
  ): Promise<void> {
    context.logger.info(
      `Setting up subscription for channel "${this.channel}"`,
    );
    const channel = this.messageChannel(context);
    if (abortController.signal.aborted) {
      context.logger.debug(
        `Subscription aborted for channel "${this.channel}"`,
      );
      return Promise.resolve();
    }

    // Return a promise that won't resolve until the subscription is cancelled
    return new Promise<void>((resolve) => {
      channel.subscribe(
        context,
        this.channel,
        async (exchange: Exchange<T>) => {
          await handler(exchange.body as T, exchange.headers);
        },
      );

      abortController.signal.addEventListener("abort", async () => {
        await channel.unsubscribe(context, this.channel);
        resolve();
      });
    });
  }

  private messageChannel(context: CraftContext): MessageChannel<Exchange<T>> {
    let store = context.getStore(ChannelAdapter.ADAPTER_CHANNEL_STORE) as
      | Map<string, MessageChannel<Exchange<T>>>
      | undefined;

    // If the store is not set, create a new one
    if (!store) {
      store = new Map<string, MessageChannel<Exchange<T>>>();
      context.setStore(ChannelAdapter.ADAPTER_CHANNEL_STORE, store);
    }

    // If the channel is not in the store, create a new one
    if (!store.has(this.channel)) {
      const mergedOptions = this.mergedOptions(context);
      if (mergedOptions.channelType) {
        const MyChannelType = mergedOptions.channelType;
        store.set(
          this.channel,
          new MyChannelType(this._channel) as MessageChannel<Exchange<T>>,
        );
      } else {
        // Fallback to a default in-memory implementation
        store.set(this.channel, new InMemoryMessageChannel<Exchange<T>>());
      }
    }

    return store.get(this.channel) as MessageChannel<Exchange<T>>;
  }

  async send(exchange: Exchange<T>): Promise<void> {
    // Cast exchange to require the context
    const defaultExchange = exchange as DefaultExchange<T>;
    defaultExchange.logger.debug(
      `Preparing to send message to channel "${this.channel}"`,
    );
    const channel = this.messageChannel(defaultExchange.context);
    return await channel.send(this.channel, defaultExchange);
  }

  mergedOptions(context: CraftContext): ChannelAdapterOptions {
    const store = context.getStore(ChannelAdapter.ADAPTER_CHANNEL_OPTIONS) as
      | Partial<ChannelAdapterOptions>
      | undefined;
    return {
      ...store,
      ...this.options,
    };
  }
}

class InMemoryMessageChannel<T> implements MessageChannel<T> {
  private subscribers = new Map<string, (message: T) => Promise<void>>();

  async send(channel: string, message: T): Promise<void> {
    const handler = this.subscribers.get(channel);
    if (handler) {
      await handler(message);
    }
  }

  async subscribe(
    _context: CraftContext,
    channel: string,
    handler: (message: T) => Promise<void>,
  ): Promise<void> {
    this.subscribers.set(channel, handler);
  }

  async unsubscribe(_context: CraftContext, channel: string): Promise<void> {
    this.subscribers.delete(channel);
  }
}
