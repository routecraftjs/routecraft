import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Reserved config for direct adapter (future: channel type, whitelist, timeouts).
 * No-op today; used by built-in direct handling when implemented.
 */
export type DirectConfig = Record<string, unknown>;
import type { CraftContext } from "../../context";
import type { Exchange } from "../../exchange";
import type { RegisteredDirectEndpoint } from "../../registry";

export type DirectChannelType<T extends DirectChannel> = new (
  endpoint: string,
) => T;

export type DirectEndpoint<T = unknown> =
  | RegisteredDirectEndpoint
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
 * Options when using direct adapter as a Server (.from()).
 * Body/header validation and discovery metadata apply to incoming messages.
 */
export interface DirectServerOptions extends DirectBaseOptions {
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
 * Options when using direct adapter as a Client (.to(), .tap()).
 * Room for future options (e.g. timeout, retryPolicy).
 */
export type DirectClientOptions = DirectBaseOptions;

/** Options when using direct as a server or client (union). */
export type DirectOptions = DirectServerOptions | DirectClientOptions;
