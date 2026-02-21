import type {
  DirectRouteMetadata,
  DirectServerOptions,
  Exchange,
} from "@routecraft/routecraft";

/** Store key set by mcpPlugin() when applied; routes using .from(mcp(...)) require it. */
export const MCP_PLUGIN_REGISTERED =
  "routecraft.mcp.plugin.registered" as const;

/** Store key for named remote MCP servers (mcpPlugin({ clients })). Used by McpClient to resolve serverId. */
export const ADAPTER_MCP_CLIENT_SERVERS =
  "routecraft.mcp.client.servers" as const;

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [MCP_PLUGIN_REGISTERED]: boolean;
    [ADAPTER_MCP_CLIENT_SERVERS]: Map<string, McpClientHttpConfig | string>;
  }
}

/**
 * HTTP client config for a remote MCP server (Streamable HTTP).
 * Used in mcpPlugin({ clients: { name: config } }).
 */
export interface McpClientHttpConfig {
  transport?: "streamable-http";
  url: string;
}

/**
 * Stdio client config for a remote MCP server (subprocess).
 * Not yet accepted in plugin options; for future use.
 */
export interface McpClientStdioConfig {
  transport: "stdio";
  command: string;
  args?: string[];
}

/** Union of client configs. Plugin options use McpClientHttpConfig only for now. */
export type McpClientServerConfig = McpClientHttpConfig | McpClientStdioConfig;

/**
 * Options for the MCP plugin (mcpPlugin).
 * One plugin per adapter: this is the single options type for the MCP plugin.
 */
export interface McpPluginOptions {
  /** Server name in MCP protocol handshake. Default: "routecraft" */
  name?: string;

  /** Server version. Default: "1.0.0" */
  version?: string;

  /** Transport mode for MCP server. Default: "stdio" */
  transport?: "stdio" | "http";

  /** Port for the streamable-http MCP server. Default: 3001 (only used with transport: "http") */
  port?: number;

  /** Host to bind to. Default: "0.0.0.0" (only used with transport: "http") */
  host?: string;

  /**
   * Filter which tools to expose. Default: all mcp() routes.
   * Can be an array of endpoint names or a filter function.
   */
  tools?: string[] | ((meta: DirectRouteMetadata) => boolean);

  /**
   * Named remote MCP servers for .to(mcp("name:tool")). Keys are server names; values are HTTP config (url).
   * Stdio config not yet supported in plugin options.
   */
  clients?: Record<string, McpClientHttpConfig>;
}

/** @internal Used by MCPServer implementation; same shape as McpPluginOptions. */
export type MCPServerOptions = McpPluginOptions;

/**
 * Options for mcp() when used as a server in .from().
 * Description is required for AI/MCP discoverability.
 */
export interface McpServerOptions extends DirectServerOptions {
  /** Human-readable description (required for MCP tools). */
  description: string;
}

export type McpOptions = McpServerOptions;

/**
 * Extracts MCP tool arguments from an exchange. Default implementation uses exchange.body.
 */
export type McpArgsExtractor = (
  exchange: Exchange<unknown>,
) => Record<string, unknown>;

/**
 * Options for mcp() when used as a Client in .to() to call a remote MCP server.
 * Provide either url (inline HTTP) or serverId (from plugin/store); tool is required.
 *
 * **Stdio is not supported in routes.** Only HTTP is allowed: use `url` for an inline
 * HTTP endpoint or `serverId` for a named backend from mcpPlugin({ clients }) or
 * context store. Stdio MCP clients are managed by the plugin lifecycle only.
 */
export interface McpClientOptions {
  /** URL of the remote MCP server (HTTP/HTTPS only). Omit when using serverId. */
  url?: string;
  /** Tool name to invoke. If omitted, exchange body may specify it or a default applies. */
  tool?: string;
  /** Server id from context store; resolved to URL at runtime. Use when URL is registered via mcpPlugin({ clients }). */
  serverId?: string;
  /**
   * Extract tool arguments from the exchange. Receives the full exchange.
   * Default: body as object → use as args; otherwise { input: body }.
   */
  args?: McpArgsExtractor;
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
