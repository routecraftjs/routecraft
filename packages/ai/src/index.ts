// Cross-instance identity (Symbol.for) for MCP adapters
export {
  BRAND,
  isMcpAdapter,
  isMcpClientAdapter,
  isMcpSourceAdapter,
} from "./brand.ts";

// MCP DSL and types
export { mcp, type McpOptions, type McpServerOptions } from "./mcp/index.ts";

// MCP client adapter and types
export {
  ADAPTER_MCP_CLIENT_SERVERS,
  defaultArgs,
  McpClientAdapter,
} from "./mcp/client-adapter.ts";
export type {
  McpArgsExtractor,
  McpClientHttpConfig,
  McpClientOptions,
  McpClientServerConfig,
  McpClientStdioConfig,
} from "./mcp/types.ts";
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
