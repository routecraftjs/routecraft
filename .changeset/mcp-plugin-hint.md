---
"@routecraft/ai": patch
---

An `mcp()` source started without the MCP plugin now fails with `RC5003` and names both setups (the `mcp: {}` key in `craft.config.ts`, or `mcpPlugin()` on a context you build yourself), instead of an uncoded error pointing at `plugins: [mcpPlugin()]`.
