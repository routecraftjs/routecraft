import { type ExchangeHeaders, type HeaderValue } from "./exchange.ts";
import { type CraftContext } from "./context.ts";
import { type MessageChannel } from "./channel.ts";
import { type RouteDefinition } from "./route.ts";

export type ConsumerType<T extends Consumer, O = unknown> = new (
  context: CraftContext,
  definition: RouteDefinition,
  channel: MessageChannel<Message>,
  options: O,
) => T;

export type Message = {
  message: unknown;
  headers?: ExchangeHeaders;
};

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

export interface Consumer<O = unknown> {
  context: CraftContext;
  channel: MessageChannel<Message>;
  definition: RouteDefinition;
  options: O;
  register(
    handler: (message: unknown, headers?: ExchangeHeaders) => Promise<void>,
  ): void;
}

export class BatchConsumer implements Consumer<BatchOptions> {
  public readonly options: BatchOptions;

  constructor(
    public readonly context: CraftContext,
    public readonly definition: RouteDefinition,
    public readonly channel: MessageChannel<Message>,
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
    handler: (message: unknown, headers?: ExchangeHeaders) => Promise<void>,
  ): Promise<void> {
    let batch: Message[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flushBatch = async () => {
      if (batch.length > 0) {
        try {
          const merged = this.options.merge!(batch);
          await handler(merged.message, merged.headers);
        } catch (error) {
          this.context.logger.warn(
            `Error in batch consumer for route "${this.definition.id}":`,
            error,
          );
        }
        batch = [];
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    this.channel.subscribe(this.context, "internal", async (message) => {
      batch.push(message);

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
    });
  }
}

export class SimpleConsumer implements Consumer<never> {
  constructor(
    public readonly context: CraftContext,
    public readonly definition: RouteDefinition,
    public readonly channel: MessageChannel<Message>,
    public readonly options: never,
  ) {}

  async register(
    handler: (message: unknown, headers?: ExchangeHeaders) => Promise<void>,
  ): Promise<void> {
    this.channel.subscribe(this.context, "internal", async (message) => {
      await handler(message.message, message.headers);
    });
  }
}
