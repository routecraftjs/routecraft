import { CraftContext } from "./context.ts";
import { logger } from "./logger.ts";

export interface MessageChannel<T = unknown> {
  /** Send a message to the channel */
  send(channel: string, message: T): Promise<void>;

  /** Subscribe to a channel */
  subscribe(
    context: CraftContext,
    channel: string,
    handler: (message: T) => Promise<void>,
  ): Promise<void>;

  /** Unsubscribe from a channel */
  unsubscribe(context: CraftContext, channel: string): Promise<void>;
}

export class InMemoryMessageChannel<T = unknown> implements MessageChannel<T> {
  private subscribers: Map<string, ((message: T) => Promise<void>)[]> =
    new Map();

  async send(channel: string, message: T): Promise<void> {
    const subscribers = this.subscribers.get(channel) || [];
    await Promise.all(subscribers.map((subscriber) => subscriber(message)));
    logger.debug(
      `Message sent to ${subscribers.length} subscribers on channel "${channel}"`,
    );
  }

  subscribe(
    context: CraftContext,
    channel: string,
    handler: (message: T) => Promise<void>,
  ): Promise<void> {
    context.logger.info(`New subscription to channel "${channel}"`);
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, []);
    }
    this.subscribers.get(channel)?.push(handler);
    return Promise.resolve();
  }

  unsubscribe(context: CraftContext, channel: string): Promise<void> {
    context.logger.info(`Unsubscribing from channel "${channel}"`);
    this.subscribers.delete(channel);
    return Promise.resolve();
  }
}

export interface ChannelAdapterOptions<T = unknown> {
  channelFactory: (channel: string) => MessageChannel<T>;
}
