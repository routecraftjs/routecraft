---
"create-routecraft": patch
"@routecraft/ai": patch
---

A scaffolded project is agent-connected from the first run. Its `greet` capability stands behind `mcp()` as well as `direct()`, `craft.config.ts` serves MCP over stdio, `@routecraft/ai` (at the core version) and `@modelcontextprotocol/server` (`^2.0.0`) are dependencies, and the README shows how Claude Code, Cursor and VS Code connect to it and call the tool. `bun run start` still logs the greeting, and the capability's test mocks the `mcp()` source so it starts no transport.

`@routecraft/ai` is released with it, because the scaffold pins every `@routecraft/*` package to the core train's version and this release has to publish `@routecraft/ai` at that version. Nothing enforces that for later releases yet.
