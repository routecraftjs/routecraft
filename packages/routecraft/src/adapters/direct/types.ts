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
 * Carries the canonical internal tool fields for in-process agent discovery.
 * Overlaps structurally with other adapters (mcp, http server) on a small set
 * of tool-shape props (`endpoint` aka name, `title`, `description`, `schema`
 * aka inputSchema, `outputSchema`); adapter-specific metadata (MCP
 * annotations, MCP icons, HTTP route metadata, etc.) lives on each wrapper
 * adapter's own types and registries, not here.
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
   * Validated values are merged on top of the original request headers so that
   * callers' pass-through metadata (correlation IDs, user-supplied extras)
   * survive schemas that strip unknown keys.
   *
   * @example
   * z.looseObject({
   *   'x-tenant-id': z.string().uuid(),
   *   'x-trace-id': z.string().optional(),
   * })  // Validates required headers, keeps all others
   */
  headerSchema?: StandardSchemaV1;

  /**
   * Human-readable display title for in-process discovery consumers (agents).
   * Not used by the delivery pipeline.
   */
  title?: string;

  /**
   * Human-readable description of what this route does. Surfaced to agents
   * that inspect the direct registry.
   */
  description?: string;

  /**
   * Standard Schema for the output body, when the route produces a structured
   * response. Not enforced at runtime by direct; discovery consumers may use
   * it to document the response shape.
   */
  outputSchema?: StandardSchemaV1;
}

/**
 * Options when using direct adapter as a Client (.to(), .tap()).
 * Room for future options (e.g. timeout, retryPolicy).
 */
export type DirectClientOptions = DirectBaseOptions;

/** Options when using direct as a server or client (union). */
export type DirectOptions = DirectServerOptions | DirectClientOptions;
