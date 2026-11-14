---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
---

`agent()` and `mcp()` need their plugin. An inline `agent({ ... })` and a call to a remote tool by URL used to run in an application that installed neither plugin, on state they built on first use; both now read the application through the plugin and refuse with `RC5003` when it is absent. Add `agent: {}` or `mcp: {}` to the project, or `agentPlugin()` / `mcpPlugin()` to a context built by hand.

`mcpPlugin()` starts its server only when `transport` is set or a route is exposed with `.from(mcp())`, so an application that only calls remote tools no longer opens a stdio server on the process's standard streams.

A block resolver's second argument is a `BlockContext` (`lookup(port)` and `logger`) in place of the `CraftContext`.

A step is told when its route abandons the work it is doing: `context.route.signal` on the step context. `getExchangeContext` and `getExchangeRoute` are gone from `@routecraft/routecraft/internal`.
