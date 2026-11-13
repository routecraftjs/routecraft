---
"@routecraft/ai": minor
"@routecraft/routecraft": patch
---

Every call toward a remote MCP server's tool made from an exchange that has a context leaves a record. `plugin:mcp:remote:requested` and `plugin:mcp:remote:settled` are emitted for a call from the MCP door, from an agent and from a route's own `.to(mcp(...))` hop, with the client's `serverId` (an inline `url` call carries the URL's `origin`), the remote tool, the caller as a `PrincipalRef` (`subject`, `issuer`, `clientId`, `actorSubject`) when the call has a principal, and `policy`: `"route"` when a proxy route judged the call, `"bypassed"` when the client was reached without one. The settled event adds `outcome` (`completed`, `remote-error`, `refused`, `declined`, `deferred`, `failed`) and `durationMs`. Neither carries arguments, results or error text.

`mcpPlugin` also logs one line per client at start saying whether it is proxied, partly proxied or not proxied, so a proxy route that was removed does not leave a client open without a trace.

`@routecraft/routecraft` exports `principalRef`, the reduction of a principal to the reference an audit record keeps, so the record's `caller` is the same subset a deferral's receipt stores.
