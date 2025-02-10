import { CraftContext } from "../context.ts";
import { logger } from "../logger.ts";
import { type MessageChannel } from "../types.ts";

export class InMemoryMessageChannel<T = unknown> implements MessageChannel<T> {
  private subscribers: Map<string, ((message: T) => Promise<void>)[]> =
    new Map();

  async send(channel: string, message: T): Promise<void> {
    const subscribers = this.subscribers.get(channel) || [];
    const errors: Error[] = [];

    await Promise.all(
      subscribers.map(async (subscriber) => {
        try {
          await subscriber(message);
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.warn(`Error in channel "${channel}" subscriber:`, err);
          errors.push(err);
        }
      }),
    );

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
