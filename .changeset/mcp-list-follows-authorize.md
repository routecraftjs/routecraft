---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
---

`tools/list` shows each caller only the tools whose route `.authorize()` admits them, and `resources/list` and `resources/read` apply the same rule to MCP Apps views.

On the root and on every mount, a tool is listed to a caller only when every `.authorize()` on the route that serves it admits the caller's principal; for a proxied tool that is the covering route, exact over star. With the shipped enforcement, a caller with no principal is shown no tool whose route has `.authorize()`. `tools/call` is unchanged: the gate still runs on every call. Routes without `.authorize()`, and the `tools` filter, behave as before.

The decision is shared with the gate: `authorize()` and the new `authorizeAdmits(options, principal, authority)` make one decision, and `EnforcementPositions` gains an optional `admits`. A plugin replacing `ENFORCEMENT` decides the listing through its own `admits`; without one it keeps today's unfiltered listing. `McpServer.getAvailableTools(mount, { principal })` lists for a caller; without the second argument it is the operator's unfiltered view.
