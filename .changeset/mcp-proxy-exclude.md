---
"@routecraft/ai": minor
---

A star proxy route can leave tools out of the group: `.from(mcp({ proxy: "github:*", exclude: ["create_issue"] }))` leaves the named tools out on every mount, the rest served as before under the `tools` filter and the naming rules, and an agent that references `MCP(github:create_issue)` is not offered it unless the reference says `raw: true`, as for a route that is not live. An exact route over an excluded tool stands alone; without the exclusion an exact route wins over the star route while it is live and the star route serves the tool again when it goes. A name the client does not list warns once and leaves nothing out. `exclude` is refused with an exact proxy and on a route that is its own tool.
