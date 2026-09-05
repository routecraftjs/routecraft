import type { McpServer } from "../../src/mcp/server.ts";

/** Shape of the tool result the server hands back to a client. */
export type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Call a tool the way the SDK does, bypassing the JSON-RPC transport. */
export async function callTool(
  srv: McpServer,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await (
    srv as unknown as {
      handleToolCall(
        tool: string,
        args: Record<string, unknown>,
        principal: undefined,
      ): Promise<ToolResult>;
    }
  ).handleToolCall(tool, args, undefined)) as ToolResult;
}
