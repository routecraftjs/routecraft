---
"@routecraft/routecraft": patch
---

Browser preflight responses send `Access-Control-Allow-Headers: Authorization, *`. The Fetch spec excludes `Authorization` from the bare `*` wildcard, so a browser client sending a bearer token (the MCP Inspector's Direct mode) relied on browsers not enforcing that yet.
