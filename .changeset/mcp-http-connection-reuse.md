---
"@routecraft/ai": minor
---

A registered HTTP MCP client keeps one connection, shared by its tool listing and every call.

A call through `mcp("client:tool")`, a proxy route's hop and an agent's `MCP(client:tool)` reference used to open a connection, handshake, call and close every time. They now reuse the client's connection, so a call does not pay for a handshake and a stateful remote sees one session per client instead of one per call. If the transport fails, the connection is closed and the call is reported, not resent. A remote that answers `404` to a stale `Mcp-Session-Id` gets a fresh connection and the call once more. An inline `mcp({ url })` call still opens a connection per call.
