import {
  direct,
  error as rcError,
  type DirectServerOptions,
  type Exchange,
  type Source,
  type Destination,
} from "@routecraft/routecraft";
import { McpClientAdapter } from "./mcp/client-adapter.ts";
import { McpSourceAdapter } from "./mcp/source-adapter.ts";

/**
 * Options for mcp() when used as a Server in .from().
 * Description is required for AI/MCP discoverability.
 */
export interface McpServerOptions extends DirectServerOptions {
  /** Human-readable description (required for MCP tools). */
  description: string;
}

/**
 * Options for mcp() when used as a Client in .to() to call a remote MCP server.
 */
export interface McpClientOptions {
  /** URL of the remote MCP server (e.g. streamable HTTP or SSE endpoint). */
  url: string;
  /** Tool name to invoke. If omitted, exchange body may specify it or a default applies. */
  tool?: string;
  /** Server id from context store; resolved to URL at runtime. Use when URL is registered in context. */
  serverId?: string;
}

export type McpOptions = McpServerOptions;

/**
 * Create an MCP endpoint - a discoverable direct route for AI/MCP integration.
 *
 * `mcp()` is an alias for `direct()` with semantics oriented toward AI/MCP use cases.
 * Same two-argument pattern: mcp(endpoint, options) for source, mcp(endpoint) for destination.
 */
export function mcp<T = unknown>(
  endpoint: string,
  options: McpServerOptions,
): Source<T>;
export function mcp(options: McpClientOptions): Destination<unknown, unknown>;
export function mcp<T = unknown>(
  endpoint: string | ((exchange: Exchange<T>) => string),
): Destination<T, T>;
export function mcp<T = unknown>(
  endpointOrOptions:
    | string
    | ((exchange: Exchange<T>) => string)
    | McpClientOptions,
  options?: McpServerOptions | McpClientOptions,
): Source<T> | Destination<T, T> | Destination<unknown, unknown> {
  // Remote MCP client: .to(mcp({ url, tool })) or .to(mcp({ serverId, tool }))
  if (
    typeof endpointOrOptions === "object" &&
    endpointOrOptions !== null &&
    ("url" in endpointOrOptions || "serverId" in endpointOrOptions)
  ) {
    return new McpClientAdapter(endpointOrOptions as McpClientOptions);
  }
  const endpoint = endpointOrOptions as
    | string
    | ((exchange: Exchange<T>) => string);
  if (options !== undefined) {
    if (typeof endpoint !== "string") {
      throw rcError("RC5010", undefined, {
        message: "Dynamic endpoints cannot be used as source",
        suggestion:
          "Use a static string endpoint for source: .from(mcp('endpoint', options)).",
      });
    }
    if ("url" in options || "serverId" in options) {
      throw rcError("RC5010", undefined, {
        message:
          "mcp() with url or serverId must be used as destination: .to(mcp({ url, tool }))",
        suggestion:
          "Use .to(mcp({ url: '...', tool: '...' })) to call a remote MCP server.",
      });
    }
    return new McpSourceAdapter<T>(endpoint, options as McpServerOptions);
  }
  return direct<T>(endpoint);
}
