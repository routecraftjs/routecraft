import type { DirectRouteMetadata } from "@routecraft/routecraft";

/**
 * Options for configuring the MCP server and plugin.
 * Used by MCPServer and the RouteCraft MCP plugin.
 */
export interface MCPServerOptions {
  /** Server name in MCP protocol handshake. Default: "routecraft" */
  name?: string;

  /** Server version. Default: "1.0.0" */
  version?: string;

  /** Transport mode for MCP server. Default: "stdio" */
  transport?: "stdio" | "http";

  /** Port for the streamable-http MCP server. Default: 3001 (only used with transport: "http") */
  port?: number;

  /** Host to bind to. Default: "localhost" (only used with transport: "http") */
  host?: string;

  /**
   * Filter which tools to expose. Default: all mcp() routes.
   * Can be an array of endpoint names or a filter function.
   */
  tools?: string[] | ((meta: DirectRouteMetadata) => boolean);
}

/**
 * Represents a tool exposed via MCP
 */
export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

/**
 * MCP tool call result
 */
export interface MCPToolResult {
  content: Array<{
    type: "text" | "image" | "resource";
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}
