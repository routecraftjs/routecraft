---
"@routecraft/ai": minor
---

An agent's `MCP(server:tool)` reference now needs a proxy route, or `raw: true`. A reference to a tool no route covers used to call the remote on the client's credential under no `authorize`, no rule and no event; it is now withheld from the agent with a warning. A registered agent, or `defaultOptions.tools`, that names a configured client no route proxies at all fails the start with the new `AI1020`.

Breaking: write the reference as `{ name: 'MCP(server:tool)', raw: true }` to keep the direct call, or add `.from(mcp({ proxy: 'server:*' })).to(mcp('server:*'))` to put the agent under a route. A markdown agent's `tools` frontmatter cannot say `raw`, so it needs the route. See section 15 of the 0.7 to 0.8 migration guide.
