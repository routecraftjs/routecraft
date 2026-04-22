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
 * Per-direction schema bundle for a direct route. Groups the body and header
 * schemas so configuration is organised by direction (input vs output) rather
 * than by a flat list of `*Schema` keys. Future per-direction concerns (query,
 * params, attachments) can slot in without bloating the top-level options.
 */
export interface DirectInput {
  /** Standard Schema for the request body. */
  body?: StandardSchemaV1;
  /** Standard Schema for the request headers. Validated values merge over the originals. */
  headers?: StandardSchemaV1;
}

/**
 * Per-direction schema bundle for a direct route's output. Mirrors
 * {@link DirectInput}; both `body` and `headers` are documentation-only on the
 * output side (not runtime-enforced by direct itself).
 */
export interface DirectOutput {
  /** Standard Schema for the response body. */
  body?: StandardSchemaV1;
  /** Standard Schema for the response headers. */
  headers?: StandardSchemaV1;
}

/**
 * Metadata for a direct route stored in the direct route registry.
 *
 * Carries the canonical internal tool fields for in-process agent discovery.
 * Overlaps structurally with other adapters (mcp, http server) on a small set
 * of tool-shape props (`endpoint` aka name, `title`, `description`, `input`,
 * `output`); adapter-specific metadata (MCP annotations, MCP icons, HTTP route
 * metadata, etc.) lives on each wrapper adapter's own types and registries,
 * not here.
 */
export interface DirectRouteMetadata {
  /** Route name (matches the sanitized endpoint). */
  endpoint: string;
  /** Human-readable display title. */
  title?: string;
  /** Human-readable description of what this route does. */
  description?: string;
  /** Input schemas (request body, request headers). */
  input?: DirectInput;
  /** Output schemas (response body, response headers); documentation-only. */
  output?: DirectOutput;
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
   * Input schemas for the request side. `input.body` and `input.headers` are
   * runtime-enforced before the route handler runs. Header validation merges
   * validated values over the originals so caller-supplied pass-through keys
   * survive schemas that strip unknowns.
   *
   * @example
   * input: {
   *   body: z.object({ url: z.string().url() }),
   *   headers: z.looseObject({ 'x-tenant-id': z.string().uuid() }),
   * }
   */
  input?: DirectInput;

  /**
   * Output schemas for the response side. Documentation-only: not enforced at
   * runtime by direct. Discovery consumers (agents inspecting the registry)
   * may use them to document or generate clients for the response shape.
   */
  output?: DirectOutput;

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
}

/**
 * Options when using direct adapter as a Client (.to(), .tap()).
 * Room for future options (e.g. timeout, retryPolicy).
 */
export type DirectClientOptions = DirectBaseOptions;

/** Options when using direct as a server or client (union). */
export type DirectOptions = DirectServerOptions | DirectClientOptions;
