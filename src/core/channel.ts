import { type Exchange } from "./exchange.ts";

/**
 * MessageChannel interface for handling message streams
 * Implementations include KV, Kafka, Redis, and Google PubSub
 */
export interface MessageChannel<T = Exchange> {
  readonly namespace: string;

  /**
   * Publishes a message to the channel
   * @param message The message to publish
   */
  publish(message: T): Promise<void>;

  /**
   * Consumes and removes the next message from the channel
   * @returns The next message or undefined if empty
   */
  consume(): Promise<T | undefined>;

  /**
   * Views the next message without consuming it
   * @returns The next message or undefined if empty
   */
  peek(): Promise<T | undefined>;

  /**
   * Returns the number of pending messages
   */
  count(): Promise<number>;

  /**
   * Removes all messages from the channel
   */
  clear(): Promise<void>;
}

/**
 * In-memory implementation for testing
 */
export class InMemoryMessageChannel<T = Exchange> implements MessageChannel<T> {
  private messages: T[] = [];
  readonly namespace: string;

  constructor(namespace: string) {
    this.namespace = namespace;
  }

  publish(message: T): Promise<void> {
    this.messages.push(message);
    return Promise.resolve();
  }

  consume(): Promise<T | undefined> {
    return Promise.resolve(this.messages.shift());
  }

  peek(): Promise<T | undefined> {
    return Promise.resolve(this.messages[0]);
  }

  count(): Promise<number> {
    return Promise.resolve(this.messages.length);
  }

  clear(): Promise<void> {
    this.messages = [];
    return Promise.resolve();
  }
}

export interface MessageChannelFactory<T = Exchange> {
  create(namespace: string): MessageChannel<T>;
}
