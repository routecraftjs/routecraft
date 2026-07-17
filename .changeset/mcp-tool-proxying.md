---
"@routecraft/ai": minor
---

Proxy selected tools from registered MCP clients through the Routecraft MCP server.

`mcpPlugin({ proxy })` re-exposes tools from `clients` without a route per tool: `"server:tool"` proxies one tool, `"server:*"` (or bare `"server"`) proxies every tool the client advertises, and the `{ ref, name?, description?, annotations? }` form renames or re-documents a single tool. Proxied tools appear in `tools/list` with the remote input/output schema, title, description, annotations, and icons passed through, and `tools/call` dispatches over the client's registered transport and auth with the raw remote result (`content`, `structuredContent`, `isError`) returned verbatim. Selection resolves against the live tool registry, so wildcards follow tool refresh and stdio restarts. Name collisions are deterministic: local `.from(mcp())` routes win over proxied tools, and earlier `proxy` entries win over later ones, each with a once-per-name warning. Refs are validated at plugin creation (unknown client, malformed ref, wildcard rename, duplicate exposed name all throw).

Proxied calls run no route pipeline (no `authorize()`, validation, or resilience wrappers) and do not forward the caller's principal; the Routecraft-to-client hop authenticates with the client's registered `auth`. Reserve `proxy` for simple, read-only tools and put anything needing guardrails behind a `.from(mcp())` route.

Supporting changes: the `tools` filter now applies to `tools/call` as well as `tools/list`, so a filtered-out local tool is no longer callable; `McpToolRegistryEntry` retains `title`, `outputSchema`, and `icons` from remote listings; `StdioClientManager.callToolRaw`, `dispatchMcpCallRaw`, and `callRemoteToolRaw` expose the raw MCP result path; and the `plugin:mcp:tool:*` events carry optional `proxied` / `serverId` / `remoteTool` fields.
