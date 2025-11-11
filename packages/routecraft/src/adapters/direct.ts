import {
  type ExchangeHeaders,
  type Exchange,
  type DefaultExchange,
} from "../exchange";
import { type Source } from "../operations/from";
import { CraftContext, type MergedOptions } from "../context";
import { type Destination } from "../operations/to";
import { error } from "../error";

export type DirectChannelType<T extends DirectChannel> = new (
  endpoint: string,
) => T;

export type DirectEndpoint<T = unknown> =
  | string
  | ((exchange: Exchange<T>) => string);

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

  private rawEndpoint: DirectEndpoint<T>;

  constructor(
    rawEndpoint: DirectEndpoint<T>,
    public options: Partial<DirectAdapterOptions> = {},
  ) {
    this.rawEndpoint = rawEndpoint;
  }

  private resolveEndpoint(exchange: Exchange<T>): string {
    const endpoint =
      typeof this.rawEndpoint === "function"
        ? this.rawEndpoint(exchange)
        : this.rawEndpoint;
    return endpoint.replace(/[^a-zA-Z0-9]/g, "-");
  }

  async subscribe(
    context: CraftContext,
    handler: (message: T, headers?: ExchangeHeaders) => Promise<Exchange>,
    abortController: AbortController,
  ): Promise<void> {
    if (typeof this.rawEndpoint === "function") {
      throw error("RC5010", undefined, {
        message: "Dynamic endpoints cannot be used as source",
        suggestion:
          'Direct adapter with function endpoint can only be used with .to() or .tap(), not .from(). Use a static string endpoint for .from(direct("endpoint")).',
      });
    }

    // At this point we know rawEndpoint is a string
    const endpoint = this.rawEndpoint.replace(/[^a-zA-Z0-9]/g, "-");

    context.logger.debug(
      `Setting up subscription for direct endpoint "${endpoint}"`,
    );
    const channel = this.directChannel(context, endpoint);
    if (abortController.signal.aborted) {
      context.logger.debug(
        `Subscription aborted for direct endpoint "${endpoint}"`,
      );
      return;
    }

    // Set up the subscription
    await channel.subscribe(
      context,
      endpoint,
      async (exchange: Exchange<T>) => {
        // Call handler and return the result
        const result = await handler(exchange.body as T, exchange.headers);
        return result as Exchange<T>;
      },
    );

    // Set up cleanup on abort
    abortController.signal.addEventListener("abort", async () => {
      await channel.unsubscribe(context, endpoint);
    });
  }

  private directChannel(
    context: CraftContext,
    endpoint: string,
  ): DirectChannel<Exchange<T>> {
    let store = context.getStore(DirectAdapter.ADAPTER_DIRECT_STORE) as
      | Map<string, DirectChannel<Exchange<T>>>
      | undefined;

    // If the store is not set, create a new one
    if (!store) {
      store = new Map<string, DirectChannel<Exchange<T>>>();
      context.setStore(DirectAdapter.ADAPTER_DIRECT_STORE, store);
    }

    // If the endpoint is not in the store, create a new one
    if (!store.has(endpoint)) {
      const mergedOptions = this.mergedOptions(context);
      if (mergedOptions.channelType) {
        const MyChannelType = mergedOptions.channelType;
        store.set(
          endpoint,
          new MyChannelType(endpoint) as DirectChannel<Exchange<T>>,
        );
      } else {
        // Fallback to a default in-memory implementation
        store.set(endpoint, new InMemoryDirectChannel<Exchange<T>>());
      }
    }

    return store.get(endpoint) as DirectChannel<Exchange<T>>;
  }

  async send(exchange: Exchange<T>): Promise<void> {
    // Cast exchange to require the context
    const defaultExchange = exchange as DefaultExchange<T>;

    // Resolve endpoint dynamically if needed
    const endpoint = this.resolveEndpoint(exchange);

    defaultExchange.logger.debug(
      `Preparing to send message to direct endpoint "${endpoint}"`,
    );
    const channel = this.directChannel(defaultExchange.context, endpoint);

    // Send and wait for result - this is synchronous blocking behavior
    const result = await channel.send(endpoint, defaultExchange);

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
