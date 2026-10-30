---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
---

An exact MCP proxy route whose remote tool its client does not list says so instead of falling silent.

At start, and at every change to the clients' tools or to the proxy registrations, the MCP server checks each exact `mcp({ proxy: "client:tool" })` route against the tools its client lists. A route whose tool is missing (renamed or removed by the vendor, or a client that has listed no tools) is logged once at warn with the tools the client does list, and put on standby with the new core event `route:standby:changed` (`{ routeId, standby, reason? }`). Ops reports a route on standby as `inactive` with lifecycle `standby` and `details.reason`, excluded from the aggregate; it returns to `running`, with an info line, when a listing carries the tool again. Calls stay fail-closed, unchanged. `McpToolRegistry.onChange(listener)` runs a listener on every change to the registered tools.
