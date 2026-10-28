---
"@routecraft/ai": minor
---

Proxy routes advertise the schemas their steps produce, so a route can redact a result or pin an argument.

- An exact proxy route's `.input()` and `.output()` are advertised on `tools/list` and in an agent's `MCP(server:tool)` catalogue in place of the remote's, and enforced as on any route; `.output()` carries the `Deferred` arm when the route can park. This fixes #912: a narrower `.input()` was enforced but never advertised.
- A star proxy route takes `mcp({ proxy: "server:*", schemas: (remote) => ({ input?, output? }) })` to derive each tool's advertised JSON Schemas from the remote's; `output: null` advertises none. New types `McpProxySchemas`, `McpProxiedToolInfo`, `McpDerivedSchemas`.
- Breaking: `.input()` or `.output()` on a star proxy route now fails its source at start with `RC5003` (it used to enforce one schema on every tool while advertising the remote's). Use an exact route for the tool, or `schemas`. `schemas` beside an exact proxy is refused when `mcp()` is called.
