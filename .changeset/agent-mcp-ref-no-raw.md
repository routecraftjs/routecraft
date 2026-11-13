---
"@routecraft/ai": minor
---

**Breaking (canary only):** the `raw` key on an agent `tools` item is removed. An `MCP(server:tool)` reference runs through the route that proxies the tool when one exists, and reaches the client directly when no proxy route covers or declares the tool; a reference has no flag that skips a proxy route. An agent that must reach a proxied tool outside that route's policy is given a route of its own, `.from(direct())` ending in `.to(mcp("server:tool"))`, referenced as `Direct(<routeId>)`. `raw` never shipped in a stable release.
