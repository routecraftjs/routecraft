---
"@routecraft/ai": minor
---

MCP tool calls carry the caller's journey, and an agent's tool calls record the turn as their cause.

- **Client.** An `mcp()` call and an agent's `MCP(...)` tool send the calling exchange's W3C trace context in the call's `_meta` (`traceparent`, `tracestate`, as SEP-414 defines them), over stdio and HTTP alike. `traceContext: false` on `mcp()` or on a client registered under `mcpPlugin({ clients })` sends nothing; unset follows the config's `traceContext.outbound`, and the most specific setting wins.
- **Server.** `mcpPlugin({ traceContext })` decides whether a tool call's `_meta` trace context joins the exchange to the caller's journey: `"authenticated"` (the default) only from a caller whose token `auth` verified, `"always"` from any caller, `"never"` from none.
- **Agent tools.** `FnHandlerContext` gains `exchangeId`, the calling exchange's id beside `correlationId`, and a `directTool` dispatch records it as the route's `routecraft.causation_id`.
- **Revived sessions.** A session an idle settlement revives (a parked background call whose execution two ended) names that execution two as `resumerExchangeId` on the revived turn's `route:exchange:resumed`, so a ledger walks from the approval that resumed the call, to the call, to the turn it woke. The revived turn keeps its own correlation and causation ids.
- **Editor surface.** A `surface()` call, and a turn's cancellation, resolve the editor turn by correlation id only for an exchange called into the turn. An exchange that claimed its correlation id (adopted at a door, re-stamped by `.correlate()`, continued by an `event()` delivery) resolves no surface, neither by that id nor by a surface header it carried before it re-stamped, and fails with `AI1013`, since the id now travels in the `tracestate` of the calls the turn makes. A surface the exchange resolved before it re-stamped stays its own, under the turn it resolved it in.
