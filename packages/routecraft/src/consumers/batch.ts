import { randomUUID } from "node:crypto";
import { CraftContext } from "../context.ts";
import { type RouteDefinition } from "../route.ts";
import {
  type ProcessingQueue,
  type Message,
  type Consumer,
  type EventName,
  type EventHandler,
} from "../types.ts";
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
    handler: (
      message: unknown,
      headers?: ExchangeHeaders,
      parse?: (raw: unknown) => unknown | Promise<unknown>,
    ) => Promise<Exchange>,
  ): Promise<void> {
    let batch: Message[] = [];
    let resolvers: {
      resolve: (ex: Exchange) => void;
      reject: (e: unknown) => void;
    }[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const batchId = randomUUID();
    let batchStartTime: number | null = null;

    const flushBatch = async (reason: "size" | "time") => {
      if (batch.length > 0) {
        const currentBatch = batch;
        const currentResolvers = resolvers;
        const waitTime =
          batchStartTime === null ? 0 : Date.now() - batchStartTime;
        batch = [];
        resolvers = [];
        batchStartTime = null;

        // Emit batch:flushed event
        this.context.emit(
          `route:${this.definition.id}:batch:flushed` as const,
          {
            routeId: this.definition.id,
            batchSize: currentBatch.length,
            batchId,
            waitTime,
            reason,
          },
        );

        try {
          const merged = this.options.merge!(currentBatch);
          const finalExchange = await handler(merged.message, merged.headers);
          for (const { resolve } of currentResolvers) {
            resolve(finalExchange);
          }
        } catch (error) {
          this.context.logger.warn(
            { err: error, route: this.definition.id },
            "Batch consumer handler failed",
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
      // When a source adapter attaches a `parse` function (see #187), the
      // batch consumer cannot defer it to the synthetic pipeline step that
      // the simple consumer relies on: the merged batch exchange has no
      // per-item parse function, so the runtime cannot apply parsing after
      // batching. We pre-parse here so the batch contains parsed values.
      //
      // On parse failure we route the bad item through the pipeline as its
      // own per-item exchange (handler invoked with the raw message and the
      // captured parse function so the synthetic parse step throws RC5016).
      // This preserves `onParseError: 'fail'` semantics: the route's
      // `.error()` handler fires, `exchange:failed` fires when no handler
      // is set, and the source's per-item `.catch()` continues. The bad
      // item is NOT added to the in-progress batch.
      if (message.parse) {
        const itemParse = message.parse;
        const rawMessage = message.message;
        try {
          message.message = await itemParse(rawMessage);
        } catch {
          return handler(rawMessage, message.headers, itemParse);
        }
        delete message.parse;
      }

      const promise = new Promise<Exchange>((resolve, reject) => {
        batch.push(message);
        resolvers.push({ resolve, reject });
      });

      if (batch.length === 1) {
        batchStartTime = Date.now();

        this.context.emit(
          `route:${this.definition.id}:batch:started` as const,
          {
            routeId: this.definition.id,
            batchSize: this.options.size!,
            batchId,
          },
        );

        if (timer) {
          clearTimeout(timer);
        }
        timer = setTimeout(async () => {
          await flushBatch("time");
        }, this.options.time!);
      }

      if (batch.length >= this.options.size!) {
        await flushBatch("size");
      }
      return promise;
    });

    // Listen for route stopping to emit batch:stopped
    const unsubscribe = this.context.on(
      "route:*:stopping" as EventName,
      ((payload: { details: { route: { definition: { id: string } } } }) => {
        if (payload.details.route.definition.id === this.definition.id) {
          // Clear any pending timer
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }

          // Reject all pending promises to prevent memory leaks
          for (const { reject } of resolvers) {
            reject(new Error("BatchConsumerStopped: Route is shutting down"));
          }
          resolvers.length = 0;

          // Emit batch:stopped event
          this.context.emit(
            `route:${this.definition.id}:batch:stopped` as const,
            {
              routeId: this.definition.id,
              batchId,
            },
          );

          // Unsubscribe after emitting
          unsubscribe();
        }
      }) as EventHandler<EventName>,
    );
  }
}
