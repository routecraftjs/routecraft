import { port } from "@routecraft/routecraft";
import { McpToolRegistry } from "./tool-registry.ts";
import type {
  McpClientHttpConfig,
  McpClientStdioConfig,
  McpLocalToolEntry,
  McpStdioToolCaller,
} from "./types.ts";

/**
 * What the MCP plugin provides: the tools this application serves and the
 * clients it calls. The `mcp()` source registers its routes here, and the
 * agent tool selection, the `mcp()` client and the proxy read the clients'
 * tools from here.
 */
export interface McpService {
  /**
   * The `.from(mcp())` routes this application serves as tools, by tool
   * name. Written by the `mcp()` source when a route subscribes, and read
   * by the MCP server for `tools/list` and `tools/call`.
   */
  readonly local: Map<string, McpLocalToolEntry>;
  /** Every tool discovered from the configured clients. */
  readonly tools: McpToolRegistry;
  /** The managed stdio clients, by server id. */
  readonly stdio: Map<string, McpStdioToolCaller>;
  /** The configured clients, by server id. */
  readonly clients: Map<
    string,
    McpClientHttpConfig | McpClientStdioConfig | string
  >;
}

/** The MCP service the MCP plugin provides. */
export const MCP = port<McpService>("routecraft.ai.mcp@1");

/**
 * An empty MCP service, for the plugin to fill.
 *
 * @internal
 */
export function createMcpService(): McpService {
  return {
    local: new Map(),
    tools: new McpToolRegistry(),
    stdio: new Map(),
    clients: new Map(),
  };
}
