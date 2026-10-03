---
"create-routecraft": patch
"@routecraft/ai": patch
---

A scaffolded project is agent-connected from the first run. Its `greet` capability stands behind `mcp()` as well as `direct()`, `craft.config.ts` serves MCP over stdio, `@routecraft/ai` and `@modelcontextprotocol/server` are dependencies, and the README shows how Claude Code, Cursor and VS Code connect to it and call the tool. `bun run start` still logs the greeting, and the capability's test mocks the `mcp()` source so it starts no transport.

`@routecraft/ai` is released with it: the scaffold pins every `@routecraft/*` package to the core train's version, so the train cannot move to a version `@routecraft/ai` does not have.
