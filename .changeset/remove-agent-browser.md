---
"@routecraft/os": minor
---

`agentBrowser()` is removed. It wrapped the JavaScript library of `agent-browser` 0.17, which that project dropped in 0.20 for a Rust binary, so the adapter was pinned to an unmaintained release whose dependency chain (`webdriverio` -> `@puppeteer/browsers` -> `extract-zip`, and `basic-ftp`) carried high-severity advisories with no fixed version. `agent-browser` is no longer a peer of `@routecraft/os`, which now ships `shell()` alone. A route that drove a browser reaches one through a browser MCP server via `mcp()` instead.
