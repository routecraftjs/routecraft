import { CraftContext } from "../context.ts";
import { logger } from "../logger.ts";
import { type MessageChannel } from "../types.ts";

export class InMemoryMessageChannel<T = unknown> implements MessageChannel<T> {
  private subscribers: Map<string, ((message: T) => Promise<void>)[]> =
    new Map();
  private buffers: Map<string, T[]> = new Map();

  async send(channel: string, message: T): Promise<void> {
    const subscribers = this.subscribers.get(channel) || [];
    if (subscribers.length === 0) {
      // Buffer when no subscribers yet
      const q = this.buffers.get(channel) ?? [];
      q.push(message);
      this.buffers.set(channel, q);
      logger.debug(
        `Buffered message on channel "${channel}" (no subscribers yet)`,
      );
      return;
    }

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
    // Flush any buffered messages in FIFO order
    const q = this.buffers.get(channel);
    if (q && q.length > 0) {
      context.logger.debug(
        `Flushing ${q.length} buffered messages on channel "${channel}"`,
      );
      // Deliver sequentially to preserve order
      const deliver = async () => {
        while (q.length > 0) {
          const msg = q.shift() as T;
          await handler(msg);
        }
      };
      void deliver();
      this.buffers.delete(channel);
    }
    return Promise.resolve();
  }

  unsubscribe(context: CraftContext, channel: string): Promise<void> {
    context.logger.info(`Unsubscribing from channel "${channel}"`);
    this.subscribers.delete(channel);
    return Promise.resolve();
  }
}
