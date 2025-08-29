import { type ProcessingQueue } from "./types.ts";
// no-op

/**
 * In-memory processing queue used internally by a route to pass
 * messages from the source to the consumer. It's intentionally
 * simpler than the public message channel used by ChannelAdapter.
 */
export class InMemoryProcessingQueue<T = unknown>
  implements ProcessingQueue<T>
{
  private handler: ((message: T) => Promise<void>) | undefined;
  private buffer: T[] = [];

  async enqueue(message: T): Promise<void> {
    if (!this.handler) {
      this.buffer.push(message);
      return;
    }
    await this.handler(message);
  }

  setHandler(handler: (message: T) => Promise<void>): Promise<void> | void {
    this.handler = handler;

    const q = this.buffer;
    if (q.length > 0) {
      const deliver = async () => {
        while (q.length > 0) {
          await handler(q.shift()!);
        }
      };
      void deliver();
      this.buffer = [];
    }
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.handler = undefined;
    this.buffer = [];
    return Promise.resolve();
  }
}
