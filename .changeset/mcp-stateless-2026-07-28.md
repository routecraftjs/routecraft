---
"@routecraft/ai": minor
---

MCP protocol revision 2026-07-28: the MCP server is now stateless.

`mcpPlugin({ transport: 'http' })` used to mint a session id per client and hold a live `Server` + transport pair in an in-process map keyed by that id. Every request after `initialize` had to land on the process that owned the session, so an MCP server could not be scaled horizontally without sticky sessions and could not run on per-request compute at all. That was also the only stateful thing in an otherwise stateless framework: a Routecraft route is already a request-to-exchange pipeline with no affinity.

Revision 2026-07-28 removes protocol-level sessions entirely, and this release adopts it. The server builds a fresh instance per request from one factory, so any replica can answer any request behind a plain round-robin load balancer. The authenticated principal now travels with the request instead of through request-scoped ambient storage.

2025-era clients keep working: a request carrying no per-request `_meta` envelope is served through the SDK's stateless 2025 path from the same factory. Outbound MCP clients (`mcpPlugin({ clients })`, `mcp()` as an enricher, agent tool dispatch) negotiate with `server/discover` and fall back to the `initialize` handshake against servers that only speak 2025.

Breaking changes:

- The optional peer `@modelcontextprotocol/sdk` (v1) is replaced by the v2 package split. Install the packages for the surfaces you use: `@modelcontextprotocol/server` and `@modelcontextprotocol/node` for `transport: 'http'`, `@modelcontextprotocol/server` for `transport: 'stdio'`, and `@modelcontextprotocol/client` for outbound clients. `express` is no longer a peer at all.
- Successful authentication now logs at `debug` rather than `info` on both auth paths. Auth is verified per request rather than once per session, so an `info` line per tool call would put a subject identifier in the log stream at agent-loop rates. The `auth:success` event is unchanged and remains the signal to subscribe to.
- Outbound MCP clients advertise the real `@routecraft/ai` package version as `clientInfo.version` instead of a hardcoded `1.0.0`.
- The `plugin:mcp:session:created` and `plugin:mcp:session:closed` events are removed. There are no sessions to observe; use `plugin:mcp:tool:called` / `:completed` / `:failed` for per-call observability.
- `McpHeadersKeys.SESSION` is removed, along with the `"routecraft.mcp.session"` exchange header. Read `McpHeadersKeys.REQUEST` (`"routecraft.mcp.request"`) instead: a per-request correlation id. The old key never identified a session, and its value shape changed with this release, so an alias would have misled rather than helped.
- `Access-Control-Expose-Headers` no longer lists `Mcp-Session-Id` or `Last-Event-ID`. The revision removed both sessions and SSE resumability, so neither header is ever emitted.
- 2025-era exchanges over HTTP are answered as a single SSE frame rather than a plain JSON body. Both are valid Streamable HTTP and every MCP client handles both; only code parsing the raw response body is affected.

`oauth()` becomes a resource-server helper rather than an authorization-server proxy:

- It no longer mounts `/authorize`, `/token`, `/register` or `/revoke`. The MCP server verifies bearer tokens, enforces `requiredScopes`, and advertises its Authorization Server through RFC 9728 metadata; clients run the flow directly against the IdP. Revision 2026-07-28 deprecated Dynamic Client Registration in favour of Client ID Metadata Documents and steers MCP servers towards delegating to a dedicated provider, so proxying it was working against the spec.
- `oauth({ endpoints, client })` are removed. Pass `issuer` instead (or let `jwks()` / `jwt()` supply it), plus the optional `requiredScopes`. `OAuthAuthOptions`, `OAuthProxyEndpoints`, `OAuthClientInfo`, `OAuthClientSupplier` and `isOAuthAuth` are removed with them. `mcpPlugin` refuses the old `{ provider, endpoints, verifyAccessToken }` shape at construction with the migration message, rather than starting and then refusing every request.
- A token missing a required scope is now refused with `403 insufficient_scope` and a `WWW-Authenticate` naming the missing scope, rather than the SDK middleware's response.
- Verification failures caused by infrastructure (an unreachable JWKS endpoint, a failed `userinfo` fetch) answer `500` on every auth mode, so a client retries rather than discarding a credential that is probably valid. Previously only the OAuth path did this.
- A principal whose `expiresAt` has elapsed (or is not a finite timestamp) is refused with `401` on every auth mode, whether or not a route declares an expiry requirement. The removed SDK bearer middleware enforced this only on the OAuth path.
- `requiredScopes` entries are validated against the RFC 6749 scope-token grammar at construction. A scope containing a space, a quote or a backslash would have been split or would have broken the `WWW-Authenticate` header it is echoed into.
- The `auth:rejected` detail no longer carries `path: "oauth"`; there is one auth path.

Migration: point clients at your IdP's own authorization and token endpoints. They will find it from the `authorization_servers` field of `/.well-known/oauth-protected-resource`, which Routecraft serves, and from the `resource_metadata` hint on a `401`.
