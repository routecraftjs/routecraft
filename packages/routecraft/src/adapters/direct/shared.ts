import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { CraftContext } from "../../context";
import { rcError } from "../../error";
import type {
  DirectChannel,
  DirectChannelType,
  DirectRouteMetadata,
} from "./types";
import type { Exchange } from "../../exchange";

/**
 * Store key for the direct channel map (endpoint name -> channel instance).
 */
export const ADAPTER_DIRECT_STORE = Symbol.for(
  "routecraft.adapter.direct.store",
);

/**
 * Store key for merged direct adapter options.
 */
export const ADAPTER_DIRECT_OPTIONS = Symbol.for(
  "routecraft.adapter.direct.options",
);

/**
 * Store key for the direct route registry (endpoint -> metadata).
 */
export const ADAPTER_DIRECT_REGISTRY = Symbol.for(
  "routecraft.adapter.direct.registry",
);

/**
 * Options that can be stored globally in the context.
 */
export interface DirectOptionsMerged {
  channelType?: DirectChannelType<DirectChannel>;
  schema?: StandardSchemaV1;
  headerSchema?: StandardSchemaV1;
  description?: string;
  keywords?: string[];
}

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [ADAPTER_DIRECT_STORE]: Map<string, DirectChannel<Exchange>>;
    [ADAPTER_DIRECT_OPTIONS]: Partial<DirectOptionsMerged>;
    [ADAPTER_DIRECT_REGISTRY]: Map<string, DirectRouteMetadata>;
  }
}

/**
 * Get or create the direct channel for the given endpoint.
 *
 * @param context - The CraftContext
 * @param endpoint - The sanitized endpoint name
 * @param options - Adapter options that may contain a custom channel type
 * @returns The DirectChannel instance for this endpoint
 */
export function getDirectChannel<T>(
  context: CraftContext,
  endpoint: string,
  options: Partial<DirectOptionsMerged>,
): DirectChannel<Exchange<T>> {
  let store = context.getStore(ADAPTER_DIRECT_STORE) as
    | Map<string, DirectChannel<Exchange<T>>>
    | undefined;

  // If the store is not set, create a new one
  if (!store) {
    store = new Map<string, DirectChannel<Exchange<T>>>();
    context.setStore(ADAPTER_DIRECT_STORE, store);
  }

  // If the endpoint is not in the store, create a new one
  if (!store.has(endpoint)) {
    const mergedOptions = getMergedOptions(context, options);
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

/**
 * Merge adapter-level options with context-level options.
 *
 * @param context - The CraftContext
 * @param adapterOptions - Options passed to the adapter constructor
 * @returns Merged options
 */
export function getMergedOptions(
  context: CraftContext,
  adapterOptions: Partial<DirectOptionsMerged>,
): DirectOptionsMerged {
  const store = context.getStore(ADAPTER_DIRECT_OPTIONS) as
    | Partial<DirectOptionsMerged>
    | undefined;
  return {
    ...store,
    ...adapterOptions,
  };
}

/**
 * Register route metadata in context store for discovery.
 *
 * @param context - The CraftContext
 * @param endpoint - The sanitized endpoint name
 * @param options - Adapter options that may contain metadata
 */
export function registerRoute(
  context: CraftContext,
  endpoint: string,
  options: Partial<DirectOptionsMerged>,
): void {
  let registry = context.getStore(ADAPTER_DIRECT_REGISTRY) as
    | Map<string, DirectRouteMetadata>
    | undefined;

  if (!registry) {
    registry = new Map<string, DirectRouteMetadata>();
    context.setStore(ADAPTER_DIRECT_REGISTRY, registry);
  }

  const metadata: DirectRouteMetadata = { endpoint };
  if (options.description !== undefined) {
    metadata.description = options.description;
  }
  if (options.schema !== undefined) {
    metadata.schema = options.schema;
  }
  if (options.headerSchema !== undefined) {
    metadata.headerSchema = options.headerSchema;
  }
  if (options.keywords !== undefined) {
    metadata.keywords = options.keywords;
  }
  registry.set(endpoint, metadata);

  context.logger.debug(
    { endpoint, adapter: "direct" },
    "Registered direct route in discoverable registry",
  );
}

/**
 * Sanitize endpoint name using URL encoding for reversible, collision-free keys.
 *
 * Uses `encodeURIComponent()` to ensure distinct endpoints like "a/b" and "a-b"
 * map to unique keys ("a%2Fb" vs "a-b"), preventing routing collisions.
 *
 * @param endpoint - Raw endpoint string
 * @returns URL-encoded endpoint string safe for use as Map key
 */
export function sanitizeEndpoint(endpoint: string): string {
  return encodeURIComponent(endpoint);
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

  async send(endpoint: string, message: T): Promise<T> {
    if (this.handler) {
      // Synchronous behavior - single consumer gets the message and we wait for result
      return await this.handler(message);
    }
    throw rcError("RC5004", undefined, {
      message: `No handler subscribed on direct endpoint "${endpoint}" — route may have stopped or was never started`,
    });
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
