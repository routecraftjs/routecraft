import { type ProcessingQueue } from "./types.ts";
import { type Exchange } from "./exchange.ts";
// no-op

/**
 * In-memory processing queue used internally by a route to pass
 * messages from the source to the consumer. It's intentionally
 * simpler than the public message channel used by ChannelAdapter.
 */
export class InMemoryProcessingQueue<T = unknown>
  implements ProcessingQueue<T>
{
  private handler: ((message: T) => Promise<Exchange>) | undefined;
  private buffer: T[] = [];

  async enqueue(message: T): Promise<Exchange> {
    if (!this.handler) {
      this.buffer.push(message);
      // Resolve immediately when no handler; tests don't use return value here
      return Promise.resolve({} as Exchange);
    }
    return await this.handler(message);
  }

  setHandler(handler: (message: T) => Promise<Exchange>): Promise<void> | void {
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
