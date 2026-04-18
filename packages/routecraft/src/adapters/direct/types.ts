import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { CraftContext } from "../../context";
import type { Exchange } from "../../exchange";
import type { RegisteredDirectEndpoint } from "../../registry";

/**
 * @deprecated Use `CraftConfig.direct` (a `Pick<DirectBaseOptions, "channelType">`) instead.
 * Previously a no-op placeholder (`Record<string, unknown>`), now removed.
 * This alias exists only for migration; it will be removed in the next major version.
 */
export type DirectConfig = Pick<DirectBaseOptions, "channelType">;

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
 * Metadata for a direct route stored in the direct route registry.
 * Captures the minimal validation surface; MCP-specific fields such as
 * `description`, `keywords`, and `annotations` live on the MCP local tool
 * registry maintained by `@routecraft/ai`, not here.
 */
export interface DirectRouteMetadata {
  endpoint: string;
  schema?: StandardSchemaV1;
  headerSchema?: StandardSchemaV1;
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
}

/**
 * Options when using direct adapter as a Client (.to(), .tap()).
 * Room for future options (e.g. timeout, retryPolicy).
 */
export type DirectClientOptions = DirectBaseOptions;

/** Options when using direct as a server or client (union). */
export type DirectOptions = DirectServerOptions | DirectClientOptions;
