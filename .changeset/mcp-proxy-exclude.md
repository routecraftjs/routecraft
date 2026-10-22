---
"@routecraft/ai": minor
---

A star proxy route can leave tools out of the group: `.from(mcp({ proxy: "github:*", exclude: ["create_issue"] }))` serves every tool of the client but the named ones, on every mount, and an agent that references `MCP(github:create_issue)` is not offered it unless the reference says `raw: true`, as for a route that is not live. An exact route over an excluded tool stands alone; without the exclusion an exact route wins over the star route while it is live and the star route serves the tool again when it goes. `exclude` is refused with an exact proxy and on a route that is its own tool.
