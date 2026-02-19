// DSL functions
export {
  mcp,
  type McpClientOptions,
  type McpOptions,
  type McpServerOptions,
} from "./dsl.ts";

// MCP plugin, client adapter, and types
export {
  ADAPTER_MCP_CLIENT_SERVERS,
  McpClientAdapter,
} from "./mcp/client-adapter.ts";
export {
  mcpPlugin,
  MCPServer,
  MCP_PLUGIN_REGISTERED,
  validateWithSchema,
  type McpPluginOptions,
  type MCPServerOptions,
  type MCPTool,
  type MCPToolResult,
} from "./mcp/index.ts";
