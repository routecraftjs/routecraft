import {
  type ChannelBinder,
  type MessageChannel,
} from "../adapters/channel.ts";
import { CraftContext } from "../context.ts";

export class InMemoryChannelBinder implements ChannelBinder {
  readonly name = "channel:memory";
  readonly type = "channel" as const;

  createMessageChannel<T>(channelName: string): MessageChannel<T> {
    const defaultChannelName = (channelName || "").replace(
      /[^a-zA-Z0-9]/g,
      "-",
    );
    const subscribers = new Map<string, ((message: T) => Promise<void>)[]>();
    const buffers = new Map<string, T[]>();

    return {
      async send(channel: string, message: T): Promise<void> {
        const subs = subscribers.get(channel) || [];
        if (subs.length === 0) {
          const q = buffers.get(channel) ?? [];
          q.push(message);
          buffers.set(channel, q);
          return;
        }
        await Promise.all(subs.map((fn) => fn(message)));
      },

      async subscribe(
        context: CraftContext,
        channel: string,
        handler: (message: T) => Promise<void>,
      ): Promise<void> {
        if (!subscribers.has(channel)) subscribers.set(channel, []);
        subscribers.get(channel)!.push(handler);
        const q = buffers.get(channel);
        if (q && q.length > 0) {
          const deliver = async () => {
            while (q.length > 0) {
              const next = q.shift();
              if (next !== undefined) {
                await handler(next);
              }
            }
          };
          void deliver();
          buffers.delete(channel);
        }
        context.logger.debug(
          `Subscribed to channel "${channel}" (binder default: "${defaultChannelName}")`,
        );
      },

      async unsubscribe(context: CraftContext, channel: string): Promise<void> {
        subscribers.delete(channel);
        context.logger.debug(
          `Unsubscribed from channel "${channel}" (binder default: "${defaultChannelName}")`,
        );
      },
    } satisfies MessageChannel<T>;
  }
}
