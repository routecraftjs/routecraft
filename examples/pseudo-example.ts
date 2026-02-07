/**
 * Example route using pseudo adapters.
 * These adapters have the correct shape for the DSL but throw at runtime
 * until replaced with real implementations. No casts required.
 */
import { craft, timer, log, pseudo } from "@routecraft/routecraft";

interface McpCallOptions {
  server: string;
  tool: string;
  args?: Record<string, unknown>;
}

interface GmailListResult {
  messages: GmailMessage[];
  nextPageToken?: string;
}

interface GmailMessage {
  id: string;
  subject?: string;
  from?: string;
}

const mcp = pseudo<McpCallOptions>("mcp");

export default craft()
  .id("pseudo-example")
  .from(timer({ intervalMs: 60_000, repeatCount: 1 }))
  .enrich(
    mcp<GmailListResult>({
      server: "gmail",
      tool: "messages.list",
      args: { query: "is:unread" },
    }),
  )
  .split<GmailMessage>((r) => r.messages)
  .tap(log());
