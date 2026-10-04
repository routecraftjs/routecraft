---
"@routecraft/ai": patch
---

An `mcp()` source started without the MCP plugin now fails with `RC5003` and names the `mcp: {}` key in `craft.config.ts`, instead of an uncoded error pointing at `plugins: [mcpPlugin()]`.
