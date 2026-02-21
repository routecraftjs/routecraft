import type { Exchange, Source, Destination } from "@routecraft/routecraft";
import { McpAdapter } from "./mcp-adapter.ts";
import type {
  McpArgsExtractor,
  McpClientOptions,
  McpServerOptions,
} from "./types.ts";

/**
 * Create an MCP endpoint for AI/MCP integration.
 * - .from(mcp(endpoint, options)) — source with description (MCP server).
 * - .to(mcp({ url | serverId, tool, args? })) — remote tool (MCP client).
 * - .to(mcp("server:tool", { args? })) — remote tool by name.
 * For in-process use direct("endpoint"), not mcp().
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
  endpointOrOptions: string | McpClientOptions,
  options?: McpServerOptions | { args?: McpArgsExtractor },
): Source<T> | Destination<unknown, unknown> {
  return new McpAdapter<T>(
    endpointOrOptions as
      | string
      | ((exchange: Exchange<T>) => string)
      | McpClientOptions,
    options,
  ) as Source<T> | Destination<unknown, unknown>;
}
