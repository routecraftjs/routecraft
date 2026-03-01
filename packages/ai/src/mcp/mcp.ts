/**
 * Create an MCP endpoint for AI/MCP integration.
 * - .from(mcp(endpoint, options)) — source with description (MCP server).
 *   When options.schema is provided, body type is inferred from it; otherwise unknown.
 * - .to(mcp({ url | serverId, tool, args? })) — remote tool (MCP client).
 * - .to(mcp("server:tool", { args? })) — remote tool by name.
 * For in-process use direct("endpoint"), not mcp().
 */
export { mcp } from "./adapters/mcp/index.ts";
