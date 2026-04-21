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
 *
 * Mirrors the MCP specification's `Tool` shape (name/title/description/input/
 * outputSchema/annotations/icons). Core routecraft stays neutral about what
 * consumes this metadata; agents running in-process read it to discover and
 * call direct routes. Adapter layers that wrap `direct` (such as `mcp()`) may
 * maintain their own parallel registries with narrower types.
 */
export interface DirectRouteMetadata {
  /** Route name (matches the sanitized endpoint). */
  endpoint: string;
  /** Human-readable display title. */
  title?: string;
  /** Human-readable description of what this route does. */
  description?: string;
  /** Standard Schema describing the input body. Converts to JSON Schema for discovery. */
  schema?: StandardSchemaV1;
  /** Standard Schema describing the output body (if the route produces a structured response). */
  outputSchema?: StandardSchemaV1;
  /** Standard Schema describing the expected request headers. */
  headerSchema?: StandardSchemaV1;
  /**
   * Opaque pass-through for adapter-specific annotations (e.g. MCP tool annotations).
   * Core routecraft never reads the shape; adapter wrappers narrow this to a typed
   * shape on their public options.
   */
  annotations?: unknown;
  /**
   * Opaque icons list forwarded to discovery consumers.
   * Core routecraft never reads the shape; the MCP adapter types it per the MCP spec.
   */
  icons?: unknown[];
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
   * Human-readable display title for discovery consumers (agents, MCP clients).
   * Not used by the delivery pipeline.
   */
  title?: string;

  /**
   * Human-readable description of what this route does. Surfaced to agents
   * and (when exposed via `mcp()`) to MCP clients in `tools/list`.
   */
  description?: string;

  /**
   * Standard Schema for the output body, when the route produces a structured
   * response. Not enforced at runtime by direct; discovery consumers may use it
   * to document the response shape.
   */
  outputSchema?: StandardSchemaV1;

  /**
   * Opaque pass-through for adapter-specific annotations (e.g. MCP tool annotations).
   * Core routecraft never reads the shape; adapter wrappers (such as `mcp()` in
   * `@routecraft/ai`) narrow this to a typed shape on their public options.
   */
  annotations?: unknown;

  /**
   * Opaque icons list forwarded to discovery consumers.
   * Core routecraft never reads the shape; the MCP adapter types it per the MCP spec.
   */
  icons?: unknown[];
}

/**
 * Options when using direct adapter as a Client (.to(), .tap()).
 * Room for future options (e.g. timeout, retryPolicy).
 */
export type DirectClientOptions = DirectBaseOptions;

/** Options when using direct as a server or client (union). */
export type DirectOptions = DirectServerOptions | DirectClientOptions;
