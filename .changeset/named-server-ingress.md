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

Use a separate server name to give any surface a dedicated port. Further
user-visible changes:

- Listener lifecycle events move from `plugin:http:server:listening` /
  `plugin:http:server:closed` to `server:listening`, `server:failed`, and
  `server:closed`, each carrying the server name.
- Bearer `auth:rejected` reasons are now the bounded underscore vocabulary
  shared with MCP (`invalid_token`, `unsupported_scheme`, `infrastructure`,
  `expired`, `insufficient_scope` where applicable), rather than the previous
  HTTP free-text literals.
- A bearer verification that fails on the server side (JWKS unreachable,
  network error) now answers `500` on the HTTP surface instead of
  `401 invalid token`, so clients keep their cached token during an IdP blip.
- `mcpPlugin({ transport: "http" })` now requires an explicit HTTPS
  `resource.url` unless `NODE_ENV` is exactly `development` or `test`
  (an unset `NODE_ENV` counts as production and fails closed). Previously an
  omitted `resource.url` silently advertised the bound address.
- Servers optionally take a server-level `auth` validator inherited by every
  mounted surface (opt out per mount with `auth: false`) and a
  `shutdownGraceMs` bound on graceful drain.
