import type { StandardSchemaV1 } from "@standard-schema/spec";
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
 *   When options.schema is provided, body type is inferred from it; otherwise unknown.
 * - .to(mcp({ url | serverId, tool, args? })) — remote tool (MCP client).
 * - .to(mcp("server:tool", { args? })) — remote tool by name.
 * For in-process use direct("endpoint"), not mcp().
 */
export function mcp<S extends StandardSchemaV1 | undefined = undefined>(
  endpoint: string,
  options: McpServerOptions & { schema?: S },
): Source<
  S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : unknown
>;
export function mcp(options: McpClientOptions): Destination<unknown, unknown>;
export function mcp(
  target: string,
  options?: { args?: McpArgsExtractor },
): Destination<unknown, unknown>;
export function mcp<S extends StandardSchemaV1 | undefined = undefined>(
  endpointOrOptions: string | McpClientOptions,
  options?: (McpServerOptions & { schema?: S }) | { args?: McpArgsExtractor },
):
  | Source<
      S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : unknown
    >
  | Destination<unknown, unknown> {
  return new McpAdapter<S>(
    endpointOrOptions as
      | string
      | ((exchange: Exchange<unknown>) => string)
      | McpClientOptions,
    options,
  ) as
    | Source<
        S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : unknown
      >
    | Destination<unknown, unknown>;
}
