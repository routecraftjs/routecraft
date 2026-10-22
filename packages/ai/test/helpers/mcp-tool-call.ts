import type { Principal } from "@routecraft/routecraft";
import type { McpMount, McpServer } from "../../src/mcp/server.ts";

/** Shape of the tool result the server hands back to a client. */
export type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

/**
 * Call a tool the way the SDK does, bypassing the JSON-RPC transport.
 * `principal` is the identity the HTTP transport would hand over; `mount`
 * is where the call arrives, the root when omitted.
 */
export async function callTool(
  srv: McpServer,
  tool: string,
  args: Record<string, unknown>,
  principal?: Principal,
  mount?: McpMount,
): Promise<ToolResult> {
  return (await (
    srv as unknown as {
      handleToolCall(
        tool: string,
        args: Record<string, unknown>,
        principal: Principal | undefined,
        mount?: McpMount,
      ): Promise<ToolResult>;
    }
  ).handleToolCall(tool, args, principal, mount)) as ToolResult;
}
