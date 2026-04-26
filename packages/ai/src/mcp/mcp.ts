/**
 * Create an MCP endpoint for AI/MCP integration.
 * - .from(mcp(options?)): source. Tool name comes from the route id; description
 *   and input/output schemas come from the route builder.
 * - .to(mcp({ url | serverId, tool, args? })): remote tool (MCP client).
 * - .to(mcp("server:tool", { args? })): remote tool by name.
 * For in-process use direct("endpoint"), not mcp().
 *
 * @experimental
 */
export { mcp } from "./adapters/mcp/index.ts";
