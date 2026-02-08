import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type ExchangeHeaders,
  type Exchange,
  getExchangeContext,
} from "../exchange";
import { type Source } from "../operations/from";
import { CraftContext, type MergedOptions } from "../context";
import { type Destination } from "../operations/to";
import { error as rcError } from "../error";

export type DirectChannelType<T extends DirectChannel> = new (
  endpoint: string,
) => T;

export type DirectEndpoint<T = unknown> =
  | string
  | ((exchange: Exchange<T>) => string);

/**
 * DirectChannel interface for synchronous inter-route communication.
 *
 * Semantics:
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

/**
 * Metadata for a discoverable direct route.
 * Routes with descriptions are registered in the context store.
 */
export interface DirectRouteMetadata {
  endpoint: string;
  description?: string;
  schema?: StandardSchemaV1;
  headerSchema?: StandardSchemaV1;
  keywords?: string[];
}

/** Base options shared between source and destination. */
export interface DirectBaseOptions {
  /** Custom channel implementation */
  channelType?: DirectChannelType<DirectChannel>;
}

/**
 * Options when using direct adapter as a Source (.from()).
 * Body/header validation and discovery metadata apply to incoming messages.
 */
export interface DirectSourceOptions extends DirectBaseOptions {
  /**
   * Body validation schema. Behavior depends on schema library:
   * - Zod 4: z.object() strips extras (default), z.looseObject() keeps them, z.strictObject() rejects them
   * - Valibot: check library docs for handling extra properties
   * - ArkType: check library docs for handling extra properties
   */
  schema?: StandardSchemaV1;

  /**
   * Header validation schema. Validates the headers object.
   * Behavior depends on schema library:
   * - Zod 4: z.object() strips extras (default), z.looseObject() keeps them, z.strictObject() rejects them
   * - Valibot: check library docs for handling extra properties
   * - ArkType: check library docs for handling extra properties
   *
   * If no headerSchema is provided, all headers pass through unchanged.
   * @example
   * z.looseObject({
   *   'x-tenant-id': z.string().uuid(),
   *   'x-trace-id': z.string().optional(),
   * })  // Validates required headers, keeps all others
   */
  headerSchema?: StandardSchemaV1;

  /**
   * Human-readable description of what this route does.
   * Makes route discoverable and queryable from context store.
   */
  description?: string;

  /** Keywords to help with route discovery and categorization */
  keywords?: string[];
}

/**
 * Options when using direct adapter as a Destination (.to(), .tap()).
 * Room for future options (e.g. timeout, retryPolicy).
 */
export type DirectDestinationOptions = DirectBaseOptions;

/** Options when using direct as a source or destination (union). */
export type DirectOptions = DirectSourceOptions | DirectDestinationOptions;

/** Internal: merged shape so we can read both source and destination options. */
type DirectOptionsMerged = DirectSourceOptions & DirectDestinationOptions;

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [DirectAdapter.ADAPTER_DIRECT_STORE]: Map<string, DirectChannel<Exchange>>;
    [DirectAdapter.ADAPTER_DIRECT_OPTIONS]: Partial<DirectOptionsMerged>;
    [DirectAdapter.ADAPTER_DIRECT_REGISTRY]: Map<string, DirectRouteMetadata>;
  }
}

export class DirectAdapter<T = unknown>
  implements Source<T>, Destination<T, T>, MergedOptions<DirectOptionsMerged>
{
  readonly adapterId = "routecraft.adapter.direct";
  static readonly ADAPTER_DIRECT_STORE =
    "routecraft.adapter.direct.store" as const;
  static readonly ADAPTER_DIRECT_OPTIONS =
    "routecraft.adapter.direct.options" as const;
  static readonly ADAPTER_DIRECT_REGISTRY =
    "routecraft.adapter.direct.registry" as const;

  private rawEndpoint: DirectEndpoint<T>;

  constructor(
    rawEndpoint: DirectEndpoint<T>,
    options: Partial<DirectOptions> = {},
  ) {
    this.rawEndpoint = rawEndpoint;
    this.options = options as Partial<DirectOptionsMerged>;
  }

  /** Options passed at construction. */
  public options: Partial<DirectOptionsMerged>;

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
      throw rcError("RC5010", undefined, {
        message: "Dynamic endpoints cannot be used as source",
        suggestion:
          'Direct adapter with function endpoint can only be used with .to() or .tap(), not .from(). Use .from(direct("endpoint", {})) for source.',
      });
    }

    // At this point we know rawEndpoint is a string
    const endpoint = this.rawEndpoint.replace(/[^a-zA-Z0-9]/g, "-");

    // Register route in the registry
    this.registerRoute(context, endpoint);

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

    // Wrap handler with validation if schema provided
    const wrappedHandler = this.hasValidation()
      ? this.createValidatedHandler(handler, endpoint)
      : async (exchange: Exchange<T>) => {
          const result = await handler(exchange.body as T, exchange.headers);
          return result as Exchange<T>;
        };

    // Set up the subscription
    await channel.subscribe(context, endpoint, wrappedHandler);

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

  async send(exchange: Exchange<T>): Promise<T> {
    const context = getExchangeContext(exchange);
    if (!context) {
      throw new Error("Exchange has no context — cannot send via direct");
    }

    // Resolve endpoint dynamically if needed
    const endpoint = this.resolveEndpoint(exchange);

    exchange.logger.debug(
      `Preparing to send message to direct endpoint "${endpoint}"`,
    );
    const channel = this.directChannel(context, endpoint);

    // Send and wait for result - this is synchronous blocking behavior
    const result = await channel.send(endpoint, exchange);

    // Return the body from the result exchange
    return result.body;
  }

  mergedOptions(context: CraftContext): DirectOptionsMerged {
    const store = context.getStore(DirectAdapter.ADAPTER_DIRECT_OPTIONS) as
      | Partial<DirectOptionsMerged>
      | undefined;
    return {
      ...store,
      ...this.options,
    };
  }

  /**
   * Check if this adapter has validation configured
   */
  private hasValidation(): boolean {
    return !!(this.options.schema || this.options.headerSchema);
  }

  /**
   * Register route metadata in context store for discovery
   */
  private registerRoute(context: CraftContext, endpoint: string): void {
    let registry = context.getStore(DirectAdapter.ADAPTER_DIRECT_REGISTRY) as
      | Map<string, DirectRouteMetadata>
      | undefined;

    if (!registry) {
      registry = new Map<string, DirectRouteMetadata>();
      context.setStore(DirectAdapter.ADAPTER_DIRECT_REGISTRY, registry);
    }

    const metadata: DirectRouteMetadata = { endpoint };
    if (this.options.description !== undefined) {
      metadata.description = this.options.description;
    }
    if (this.options.schema !== undefined) {
      metadata.schema = this.options.schema;
    }
    if (this.options.headerSchema !== undefined) {
      metadata.headerSchema = this.options.headerSchema;
    }
    if (this.options.keywords !== undefined) {
      metadata.keywords = this.options.keywords;
    }
    registry.set(endpoint, metadata);

    context.logger.debug(
      `Registered direct route "${endpoint}" in discoverable registry`,
    );
  }

  /**
   * Create handler that validates body and headers before calling actual handler.
   * Uses validated/coerced values if schema transforms them.
   */
  private createValidatedHandler(
    handler: (message: T, headers?: ExchangeHeaders) => Promise<Exchange>,
    endpoint: string,
  ): (exchange: Exchange<T>) => Promise<Exchange<T>> {
    return async (exchange: Exchange<T>) => {
      let validatedBody = exchange.body;
      let validatedHeaders = exchange.headers;

      // Validate body if schema provided
      if (this.options.schema) {
        let result = this.options.schema["~standard"].validate(exchange.body);
        if (result instanceof Promise) result = await result;

        if (result.issues) {
          const err = rcError("RC5011", result.issues, {
            message: `Body validation failed for direct route "${endpoint}"`,
          });
          exchange.logger.debug(
            err,
            `Validation error on endpoint "${endpoint}"`,
          );
          throw err;
        }

        // Use validated/coerced value if schema transformed it
        if (result.value !== undefined) {
          validatedBody = result.value as T;
        }
      }

      // Validate headers if headerSchema provided
      if (this.options.headerSchema) {
        let result = this.options.headerSchema["~standard"].validate(
          exchange.headers,
        );
        if (result instanceof Promise) result = await result;

        if (result.issues) {
          const err = rcError("RC5011", result.issues, {
            message: `Header validation failed for direct route "${endpoint}"`,
          });
          exchange.logger.debug(
            err,
            `Header validation error on endpoint "${endpoint}"`,
          );
          throw err;
        }

        // Use validated/coerced headers if schema transformed them
        if (result.value !== undefined) {
          validatedHeaders = result.value as ExchangeHeaders;
        }
      }

      // Create exchange with validated values
      const validatedExchange = {
        ...exchange,
        body: validatedBody,
        headers: validatedHeaders,
      } as Exchange<T>;

      // Call original handler with validated data
      return handler(
        validatedExchange.body as T,
        validatedExchange.headers,
      ) as Promise<Exchange<T>>;
    };
  }
}

/**
 * Create a direct adapter for synchronous inter-route communication.
 *
 * - direct(endpoint, options) with second argument (even {}) returns Source<T> — use in .from().
 * - direct(endpoint) or direct(function) with no second argument returns Destination<T, T> — use in .to() / .tap().
 *
 * @template T The type of data this adapter processes
 * @param endpoint The name of the direct endpoint (string) or a function that returns the endpoint name based on the exchange
 * @param options Source options (pass {} for bare source); omit for destination.
 * @returns Source<T> when options provided, Destination<T, T> when no options
 */
export function direct<T = unknown>(
  endpoint: string,
  options: Partial<DirectSourceOptions>,
): Source<T>;
export function direct<T = unknown>(
  endpoint: string | ((exchange: Exchange<T>) => string),
): Destination<T, T>;
export function direct<T = unknown>(
  endpoint: string | ((exchange: Exchange<T>) => string),
  options?: Partial<DirectOptions>,
): Source<T> | Destination<T, T> {
  if (options !== undefined) {
    if (typeof endpoint !== "string") {
      throw rcError("RC5010", undefined, {
        message: "Dynamic endpoints cannot be used as source",
        suggestion:
          "Use a static string endpoint for source: .from(direct('endpoint', {})).",
      });
    }
    return new DirectAdapter<T>(endpoint, options) as unknown as Source<T>;
  }
  return new DirectAdapter<T>(endpoint) as unknown as Destination<T, T>;
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
    // Single consumer - only one handler allowed
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
