---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
---

Add named HTTP servers and bind-time mount claims so HTTP routes, MCP, health endpoints, and custom plugins can share one listener on distinct paths while retaining isolated-server topology.

This removes the listener-owned `http.port`, `http.host`, `mcp.port`, and `mcp.host` options. Define the listener once and select it by name:

```ts
// Before
defineConfig({
  http: { host: "0.0.0.0", port: 8080 },
  plugins: [mcpPlugin({ transport: "http", host: "0.0.0.0", port: 8081 })],
})

// After: shared listener, distinct paths
defineConfig({
  servers: { public: { host: "0.0.0.0", port: 8080 } },
  http: { server: "public" },
  plugins: [mcpPlugin({ transport: "http", server: "public", path: "/mcp" })],
})
```

Use separate server names for standalone ports. Listener lifecycle events move
from `plugin:http:server:listening` to `server:listening` and `server:closed`.
Bearer `auth:rejected` reasons are now the bounded underscore vocabulary used by
MCP (`invalid_token`, `unsupported_scheme`, `infrastructure`, and `expired` where
applicable), rather than the previous HTTP free-text literals.
