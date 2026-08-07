---
"@routecraft/ai": minor
"@routecraft/routecraft": minor
---

Agent tool policy, plus one tool-name contract on `__`

**Breaking: synthetic tool names normalise on `__`.** `direct_<routeId>` becomes `direct__<routeId>` and `_block_load_<name>` becomes `_block__load__<name>`. Fn ids and the `mcp__<server>__<tool>` form are unchanged. `__` is now the only structural separator, so a single underscore is never a boundary and a route named `fetch_order` stays unambiguous against its prefix. The authoring grammar (`Direct(...)`, `MCP(...)`) does not change, and markdown frontmatter carrying raw `mcp__server__tool` still resolves. Update anything pinning a generated name: guards keyed on tool name, assertions on `toolCalls[].toolName` or `blocksLoaded[].toolName`, recorded transcripts, evals.

**Breaking: `ResolvedTool` gains a required `source` field**, a discriminated union of `fn` / `direct` / `mcp` / `block` set by the resolver. Only affects code that hand-constructs a `ResolvedTool`, such as test fixtures or a custom bridge.

**Breaking: `Direct(<routeId>)` and fn ids are validated against the provider tool-name charset.** A route id or fn id that cannot survive as a provider-facing name (`/^[A-Za-z0-9_-]{1,64}$/`) now raises `RC5003` naming the offending character or length, instead of reaching the provider and being rejected there. Expose an unsafe route id under a tool-safe alias with `directTool(routeId)`. An MCP client tool whose remote name cannot form a valid wire name is dropped from the agent's tool list with a warning rather than failing the dispatch.

**New: `agentPlugin({ toolPolicy })`**, repository-wide admission control for the agent tool surface, keyed by tool kind (`fn` / `direct` / `mcp`), each `true`, `false`, or a predicate over a read-only tool descriptor. Omitting `toolPolicy` admits everything, so existing contexts are unaffected. Supplying it makes the surface an allowlist and every kind must be decided explicitly. Enforced at the single point every agent form converges on, so no agent can opt out, and multiple installs compose with AND. A denied tool is dropped, logged, and emitted as `route:agent:tool:denied`.

**New event: `route:agent:tool:denied`**, emitted once per tool refused admission by a policy, carrying `agentName`, `toolName`, `toolKind`, and a `reason` of `rule`, `rule-error`, or `unknown-provenance`.
