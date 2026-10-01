---
"create-routecraft": patch
---

A scaffolded project is agent-connected from the first run. Its `greet` capability stands behind `mcp()` as well as `direct()`, `craft.config.ts` serves MCP over stdio, `@routecraft/ai` and `@modelcontextprotocol/server` are dependencies, and the README shows how Claude Code, Cursor and VS Code connect to it and call the tool. The hello-world caller and its test keep working as before: `bun run start` still logs the greeting.
