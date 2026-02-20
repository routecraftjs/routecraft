import {
  error as rcError,
  type Exchange,
  type Source,
  type Destination,
} from "@routecraft/routecraft";
import { McpClientAdapter } from "./client-adapter.ts";
import { MCPAdapter } from "./mcp-adapter.ts";
import { McpSourceAdapter } from "./source-adapter.ts";
import type {
  McpArgsExtractor,
  McpClientOptions,
  McpServerOptions,
} from "./types.ts";

/**
 * Create an MCP endpoint - a discoverable direct route for AI/MCP integration.
 *
 * `mcp()` is an alias for `direct()` with semantics oriented toward AI/MCP use cases.
 * - .to(mcp("server:tool", { args? })) — remote tool by name (server and tool from plugin clients).
 * - .to(mcp({ url | serverId, tool, args? })) — remote tool with explicit options.
 * - .from(mcp(endpoint, options)) — source with description.
 * - .to(mcp(endpoint)) — direct destination.
 */
export function mcp<T = unknown>(
  endpoint: string,
  options: McpServerOptions,
): Source<T>;
export function mcp(options: McpClientOptions): Destination<unknown, unknown>;
export function mcp(
  target: string,
  options?: { args?: McpArgsExtractor },
): Destination<unknown, unknown>;
export function mcp<T = unknown>(
  endpoint: string | ((exchange: Exchange<T>) => string),
): Destination<T, T>;
export function mcp<T = unknown>(
  endpointOrOptions:
    | string
    | ((exchange: Exchange<T>) => string)
    | McpClientOptions,
  options?: McpServerOptions | McpClientOptions | { args?: McpArgsExtractor },
): Source<T> | Destination<T, T> | Destination<unknown, unknown> {
  // Remote MCP client: .to(mcp({ url, tool })) or .to(mcp({ serverId, tool }))
  if (
    typeof endpointOrOptions === "object" &&
    endpointOrOptions !== null &&
    ("url" in endpointOrOptions || "serverId" in endpointOrOptions)
  ) {
    return new McpClientAdapter(endpointOrOptions as McpClientOptions);
  }

  // .to(mcp("server:tool", { args? })) — parse target and create client adapter when options is undefined or lacks description (client-style; description = server/source)
  const isClientColonOptions =
    options === undefined ||
    (typeof options === "object" &&
      options !== null &&
      !("description" in options));
  if (
    typeof endpointOrOptions === "string" &&
    endpointOrOptions.includes(":") &&
    isClientColonOptions
  ) {
    const colonIndex = endpointOrOptions.indexOf(":");
    const serverId = endpointOrOptions.slice(0, colonIndex);
    const tool = endpointOrOptions.slice(colonIndex + 1);
    const clientOptions: McpClientOptions = { serverId, tool };
    if (
      options !== undefined &&
      typeof options === "object" &&
      "args" in options &&
      options.args !== undefined
    ) {
      clientOptions.args = options.args;
    }
    return new McpClientAdapter(clientOptions);
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
    if (
      "args" in options &&
      options.args !== undefined &&
      !("description" in options)
    ) {
      throw rcError("RC5010", undefined, {
        message:
          "mcp(endpoint, { args }) is for client usage with a 'server:tool' target, not for defining a source",
        suggestion:
          "Use .to(mcp('server:tool', { args })) to call a remote tool, or .from(mcp('endpoint', { description: '...' })) to define a source.",
      });
    }
    return new McpSourceAdapter<T>(endpoint, options as McpServerOptions);
  }
  return new MCPAdapter<T>(endpoint);
}
