---
"@routecraft/ai": minor
---

A registered HTTP MCP client keeps one connection, shared by its tool listing and every call.

A call through `mcp("client:tool")`, a proxy route's hop and an agent's `MCP(client:tool)` reference used to open a connection, handshake, call and close every time. They now reuse the client's connection, so a call does not pay for a handshake and a stateful remote sees one session per client instead of one per call. A failed call is reported, not resent. A failure with no answer from the remote replaces the connection once the calls in flight on it have finished, while an HTTP error status or a JSON-RPC error keeps it. A remote that answers `404` to a stale `Mcp-Session-Id` gets a fresh connection and the call once more. Closing a connection ends its session on the remote. Because a call now shares the client its listing ran on, a result is validated against the `outputSchema` the listing advertised, as on a stdio client: a tool that declares one and returns no matching `structuredContent` now fails the call. An inline `mcp({ url })` call still opens a connection per call, without that validation.
