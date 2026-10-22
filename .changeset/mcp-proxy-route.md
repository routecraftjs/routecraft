---
"@routecraft/ai": minor
---

A route proxies a remote MCP server, or one of its tools; `mcpPlugin({ proxy })` and its `guard` are removed.

`.from(mcp({ proxy: "github:*" }))` makes a route every tool of the registered client `github`, exposed as `github_<tool>`; `.from(mcp({ proxy: "github:create_issue" }))` makes it that one tool. `.to(mcp("github:*"))` forwards whichever tool was called, with the client's credentials; steps above the hop see the arguments, steps below it the result, and the route's chain (`.authorize()`, `.cache({ when })`, `.defer()`, hooks by tag) is the policy on every tool it covers. The tools follow the client's live list; an exact route wins over a star route; the route id is never a tool. A proxied exchange carries the remote tool on `McpHeadersKeys.TOOL`, the client on `McpHeadersKeys.CLIENT`, the remote's annotations on `McpHeadersKeys.ANNOTATIONS`, and the tool name as the cache discriminator. An agent's `MCP(server:tool)` reference runs through the proxying route when one exists; `{ name, direct: true }` reaches the client directly and logs that it did. `McpProxyRegistration` replaces `McpProxyToolConfig`.

The `mcp()` client changed with it: `tool` is required and `"*"` forwards the tool on the header (the `exchange.body.tool` fallback is gone); a remote result flagged `isError` throws `AI2003` with the remote's text, on the enricher and on an agent's `MCP(...)` tool alike (#856); a remote `structuredContent` is the body when present; the call's metadata is no longer written into an object result. The stdio transport sends `tools/list_changed` when a client's re-listing changes what the server advertises.
