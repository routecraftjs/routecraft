import {
  type ExchangeHeaders,
  type Exchange,
  type DefaultExchange,
} from "../exchange";
import { type Source } from "../operations/from";
import { CraftContext, type MergedOptions } from "../context";
import { type Destination } from "../operations/to";

export type DirectChannelType<T extends DirectChannel> = new (
  endpoint: string,
) => T;

/**
 * DirectChannel interface for synchronous inter-route communication.
 *
 * Implements Apache Camel's direct: component semantics:
 * - Single consumer per endpoint (last subscriber wins)
 * - Synchronous blocking behavior (sender waits for response)
 * - Point-to-point messaging (not pub/sub)
 */
export interface DirectChannel<T = unknown> {
  send(endpoint: string, message: T): Promise<T>;
  subscribe(
    context: CraftContext,
    endpoint: string,
    handler: (message: T) => Promise<T>,
  ): Promise<void>;
  unsubscribe(context: CraftContext, endpoint: string): Promise<void>;
}

export interface DirectAdapterOptions {
  channelType?: DirectChannelType<DirectChannel>;
}

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [DirectAdapter.ADAPTER_DIRECT_STORE]: Map<string, DirectChannel<Exchange>>;
    [DirectAdapter.ADAPTER_DIRECT_OPTIONS]: Partial<DirectAdapterOptions>;
  }
}

export class DirectAdapter<T = unknown>
  implements Source<T>, Destination<T>, MergedOptions<DirectAdapterOptions>
{
  readonly adapterId = "routecraft.adapter.direct";
  static readonly ADAPTER_DIRECT_STORE =
    "routecraft.adapter.direct.store" as const;
  static readonly ADAPTER_DIRECT_OPTIONS =
    "routecraft.adapter.direct.options" as const;

  private rawEndpoint: string;

  constructor(
    rawEndpoint: string,
    public options: Partial<DirectAdapterOptions> = {},
  ) {
    this.rawEndpoint = rawEndpoint;
  }

  private get sanitizedEndpoint(): string {
    return this.rawEndpoint.replace(/[^a-zA-Z0-9]/g, "-");
  }

  async subscribe(
    context: CraftContext,
    handler: (message: T, headers?: ExchangeHeaders) => Promise<Exchange>,
    abortController: AbortController,
  ): Promise<void> {
    context.logger.info(
      `Setting up subscription for direct endpoint "${this.sanitizedEndpoint}"`,
    );
    const channel = this.directChannel(context);
    if (abortController.signal.aborted) {
      context.logger.debug(
        `Subscription aborted for direct endpoint "${this.sanitizedEndpoint}"`,
      );
      return;
    }

    // Set up the subscription
    await channel.subscribe(
      context,
      this.sanitizedEndpoint,
      async (exchange: Exchange<T>) => {
        // Call handler and return the result
        const result = await handler(exchange.body as T, exchange.headers);
        return result as Exchange<T>;
      },
    );

    // Set up cleanup on abort
    abortController.signal.addEventListener("abort", async () => {
      await channel.unsubscribe(context, this.sanitizedEndpoint);
    });
  }

  private directChannel(context: CraftContext): DirectChannel<Exchange<T>> {
    let store = context.getStore(DirectAdapter.ADAPTER_DIRECT_STORE) as
      | Map<string, DirectChannel<Exchange<T>>>
      | undefined;

    // If the store is not set, create a new one
    if (!store) {
      store = new Map<string, DirectChannel<Exchange<T>>>();
      context.setStore(DirectAdapter.ADAPTER_DIRECT_STORE, store);
    }

    // If the endpoint is not in the store, create a new one
    if (!store.has(this.sanitizedEndpoint)) {
      const mergedOptions = this.mergedOptions(context);
      if (mergedOptions.channelType) {
        const MyChannelType = mergedOptions.channelType;
        store.set(
          this.sanitizedEndpoint,
          new MyChannelType(this.rawEndpoint) as DirectChannel<Exchange<T>>,
        );
      } else {
        // Fallback to a default in-memory implementation
        store.set(
          this.sanitizedEndpoint,
          new InMemoryDirectChannel<Exchange<T>>(),
        );
      }
    }

    return store.get(this.sanitizedEndpoint) as DirectChannel<Exchange<T>>;
  }

  async send(exchange: Exchange<T>): Promise<void> {
    // Cast exchange to require the context
    const defaultExchange = exchange as DefaultExchange<T>;
    defaultExchange.logger.debug(
      `Preparing to send message to direct endpoint "${this.sanitizedEndpoint}"`,
    );
    const channel = this.directChannel(defaultExchange.context);

    // Send and wait for result - this is synchronous blocking behavior
    const result = await channel.send(this.sanitizedEndpoint, defaultExchange);

    // Update the original exchange with the result
    if (result && result !== defaultExchange) {
      defaultExchange.body = result.body;
      // Note: headers are readonly, so we can't update them directly
      // The direct adapter maintains the original exchange structure
    }
  }

  mergedOptions(context: CraftContext): DirectAdapterOptions {
    const store = context.getStore(DirectAdapter.ADAPTER_DIRECT_OPTIONS) as
      | Partial<DirectAdapterOptions>
      | undefined;
    return {
      ...store,
      ...this.options,
    };
  }
}

/**
 * Default in-memory implementation of DirectChannel.
 *
 * IMPORTANT: This implements single-consumer semantics where only the
 * last route to subscribe to an endpoint will receive messages.
 * Previous subscribers are automatically replaced (last one wins).
 */
class InMemoryDirectChannel<T> implements DirectChannel<T> {
  private handler: ((message: T) => Promise<T>) | null = null;

  async send(_endpoint: string, message: T): Promise<T> {
    if (this.handler) {
      // Synchronous behavior - single consumer gets the message and we wait for result
      return await this.handler(message);
    }
    return message; // If no handler, return original message
  }

  async subscribe(
    _context: CraftContext,
    _endpoint: string,
    handler: (message: T) => Promise<T>,
  ): Promise<void> {
    // Single consumer - only one handler allowed (Apache Camel direct behavior)
    // This replaces any existing handler (last subscriber wins)
    this.handler = handler;
  }

  async unsubscribe(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _context: CraftContext,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _endpoint: string,
  ): Promise<void> {
    this.handler = null;
  }
}
