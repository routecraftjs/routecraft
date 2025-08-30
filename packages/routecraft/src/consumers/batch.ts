import { CraftContext } from "../context.ts";
import { type RouteDefinition } from "../route.ts";
import { type ProcessingQueue, type Message, type Consumer } from "../types.ts";
import {
  type Exchange,
  type ExchangeHeaders,
  type HeaderValue,
} from "../exchange.ts";

export type BatchOptions = {
  /**
   * The size of the batch.
   */
  size?: number;
  /**
   * The timeout between batches in milliseconds.
   */
  time?: number;
  /**
   * The function to merge the produced messages.
   */
  merge?: (exchanges: { message: unknown; headers?: ExchangeHeaders }[]) => {
    message: unknown;
    headers?: ExchangeHeaders;
  };
};

export class BatchConsumer implements Consumer<BatchOptions> {
  public readonly options: BatchOptions;

  constructor(
    public readonly context: CraftContext,
    public readonly definition: RouteDefinition,
    public readonly channel: ProcessingQueue<Message>,
    options: BatchOptions,
  ) {
    this.options = {
      size: options.size ?? 1000,
      time: options.time ?? 10 * 1000,
      merge:
        options.merge ??
        ((messages) => {
          const headers: Record<string, HeaderValue> = {};
          for (const message of messages) {
            for (const [key, value] of Object.entries(message.headers ?? {})) {
              headers[key] = value;
            }
          }
          return {
            message: messages.map((message) => message.message),
            headers,
          };
        }),
    } as Required<BatchOptions>;
  }

  async register(
    handler: (message: unknown, headers?: ExchangeHeaders) => Promise<Exchange>,
  ): Promise<void> {
    let batch: Message[] = [];
    let resolvers: {
      resolve: (ex: Exchange) => void;
      reject: (e: unknown) => void;
    }[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flushBatch = async () => {
      if (batch.length > 0) {
        const currentBatch = batch;
        const currentResolvers = resolvers;
        batch = [];
        resolvers = [];
        try {
          const merged = this.options.merge!(currentBatch);
          const finalExchange = await handler(merged.message, merged.headers);
          for (const { resolve } of currentResolvers) {
            resolve(finalExchange);
          }
        } catch (error) {
          this.context.logger.warn(
            `Error in batch consumer for route "${this.definition.id}":`,
            error,
          );
          for (const { reject } of currentResolvers) {
            reject(error);
          }
        }
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    this.channel.setHandler(async (message) => {
      const promise = new Promise<Exchange>((resolve, reject) => {
        batch.push(message);
        resolvers.push({ resolve, reject });
      });

      if (batch.length === 1) {
        if (timer) {
          clearTimeout(timer);
        }
        timer = setTimeout(async () => {
          await flushBatch();
        }, this.options.time!);
      }

      if (batch.length >= this.options.size!) {
        await flushBatch();
      }
      return promise;
    });
  }
}
