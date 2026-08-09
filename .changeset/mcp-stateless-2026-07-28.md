---
"@routecraft/ai": minor
---

MCP protocol revision 2026-07-28: the MCP server is now stateless.

`mcpPlugin({ transport: 'http' })` used to mint a session id per client and hold a live `Server` + transport pair in an in-process map keyed by that id. Every request after `initialize` had to land on the process that owned the session, so an MCP server could not be scaled horizontally without sticky sessions and could not run on per-request compute at all. That was also the only stateful thing in an otherwise stateless framework: a Routecraft route is already a request-to-exchange pipeline with no affinity.

Revision 2026-07-28 removes protocol-level sessions entirely, and this release adopts it. The server builds a fresh instance per request from one factory, so any replica can answer any request behind a plain round-robin load balancer. The authenticated principal now travels with the request instead of through request-scoped ambient storage.

2025-era clients keep working: a request carrying no per-request `_meta` envelope is served through the SDK's stateless 2025 path from the same factory. Outbound MCP clients (`mcpPlugin({ clients })`, `mcp()` as an enricher, agent tool dispatch) negotiate with `server/discover` and fall back to the `initialize` handshake against servers that only speak 2025.

Breaking changes:

- The optional peer `@modelcontextprotocol/sdk` (v1) is replaced by the v2 package split. Install the packages for the surfaces you use: `@modelcontextprotocol/server` and `@modelcontextprotocol/node` for `transport: 'http'`, `@modelcontextprotocol/server` for `transport: 'stdio'`, `@modelcontextprotocol/client` for outbound clients, and `@modelcontextprotocol/server-legacy` plus `express` for `oauth()` provider mode.
- Successful authentication now logs at `debug` rather than `info` on both auth paths. Auth is verified per request rather than once per session, so an `info` line per tool call would put a subject identifier in the log stream at agent-loop rates. The `auth:success` event is unchanged and remains the signal to subscribe to.
- Outbound MCP clients advertise the real `@routecraft/ai` package version as `clientInfo.version` instead of a hardcoded `1.0.0`.
- The `plugin:mcp:session:created` and `plugin:mcp:session:closed` events are removed. There are no sessions to observe; use `plugin:mcp:tool:called` / `:completed` / `:failed` for per-call observability.
- `McpHeadersKeys.SESSION` is removed, along with the `"routecraft.mcp.session"` exchange header. Read `McpHeadersKeys.REQUEST` (`"routecraft.mcp.request"`) instead: a per-request correlation id. The old key never identified a session, and its value shape changed with this release, so an alias would have misled rather than helped.
- `Access-Control-Expose-Headers` no longer lists `Mcp-Session-Id` or `Last-Event-ID`. The revision removed both sessions and SSE resumability, so neither header is ever emitted.
- 2025-era exchanges over HTTP are answered as a single SSE frame rather than a plain JSON body. Both are valid Streamable HTTP and every MCP client handles both; only code parsing the raw response body is affected.

`oauth()` provider mode still serves the OAuth authorization-server endpoints, now via `@modelcontextprotocol/server-legacy`. The SDK deprecated that surface in favour of delegating to a dedicated IdP, so expect it to be revisited; validator auth (`jwt()`, `jwks()`, a custom validator) is unaffected and is the recommended path.
