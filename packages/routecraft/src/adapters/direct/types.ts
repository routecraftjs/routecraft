import type { CraftContext } from "../../context";
import type { Exchange } from "../../exchange";
import type { RegisteredDirectEndpoint } from "../../registry";
import type { RouteSchemas, Tag } from "../../route";

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
 * Populated from the route's `discovery` bundle at subscribe time; the
 * direct adapter mirrors the shared tool-shape fields so in-process
 * agents can inspect the available capabilities. MCP adapter keeps its
 * own registry for protocol-specific extras.
 */
export interface DirectRouteMetadata {
  /** Route name (matches the sanitized endpoint). */
  endpoint: string;
  /** Human-readable display title. */
  title?: string;
  /** Human-readable description of what this route does. */
  description?: string;
  /** Input schemas (request body, request headers). */
  input?: RouteSchemas;
  /** Output schemas (response body, response headers). */
  output?: RouteSchemas;
  /** Tags used by selectors (e.g. `tools({ tagged: "read-only" })`). */
  tags?: Tag[];
}

/** Base options shared between source and destination. */
export interface DirectBaseOptions {
  /** Custom channel implementation */
  channelType?: DirectChannelType<DirectChannel>;
}

/**
 * Options when using direct adapter as a Server (`.from()`).
 *
 * The direct source exposes only channel-level mechanism today; the shared
 * discovery metadata (title, description, input, output) lives on the
 * route via `.title()` / `.description()` / `.input()` / `.output()` and is
 * enforced by the framework regardless of adapter.
 */
export type DirectServerOptions = DirectBaseOptions;

/**
 * Options when using direct adapter as a Client (`.to()`, `.tap()`).
 * Room for future options (e.g. timeout, retryPolicy).
 */
export type DirectClientOptions = DirectBaseOptions;

/** Options when using direct as a server or client (union). */
export type DirectOptions = DirectServerOptions | DirectClientOptions;
