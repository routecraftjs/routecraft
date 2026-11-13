---
"@routecraft/ai": minor
---

An exact `mcp({ proxy: 'server:tool' })` route that is declared but not live, for instance held back by `.enabled()`, now closes its tool. The client's star route no longer takes the tool over, at the MCP server and for an agent's `MCP(server:tool)` reference alike: the exact route is the policy written for that tool, and a policy that is off is closed, not replaced by the group's. The star route serves the tool again only when the exact route is removed from the application.

`McpService` gains `isProxyDeclared(serverId, tool)`.
