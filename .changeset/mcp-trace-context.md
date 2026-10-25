---
"@routecraft/ai": minor
---

MCP tool calls carry the caller's journey, and an agent's tool calls record the turn as their cause.

- **Client.** An `mcp()` call and an agent's `MCP(...)` tool send the calling exchange's W3C trace context in the call's `_meta` (`traceparent`, `tracestate`, as SEP-414 defines them), over stdio and HTTP alike. `traceContext: false` on `mcp()` or on a client registered under `mcpPlugin({ clients })` sends nothing.
- **Server.** `mcpPlugin({ traceContext })` decides whether a tool call's `_meta` trace context joins the exchange to the caller's journey: `"authenticated"` (the default) only from a caller whose token `auth` verified, `"always"` from any caller, `"never"` from none.
- **Agent tools.** `FnHandlerContext` gains `exchangeId`, the calling exchange's id beside `correlationId`, and a `directTool` dispatch records it as the route's `routecraft.causation_id`.
