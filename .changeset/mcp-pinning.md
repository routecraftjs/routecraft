---
"@routecraft/ai": minor
"@routecraft/cli": minor
---

Pin a remote MCP server's tools to definitions you reviewed.

- `pins: { added, changed }` on a client under `mcpPlugin({ clients })` holds it to `mcp.lock`. A tool the lockfile has never seen, or one whose definition changed, is withheld (`'hold'`, the default) or served (`'serve'`, and `'warn'` for a changed one). A withheld tool is absent from the server's listing and from an agent's tools, and a call to it fails with the new `AI2004` on every path. With `pins` set and no readable lockfile the application does not start. The new `lockfile` plugin option moves the file.
- `craft mcp pin [client]` writes the lockfile from what the clients list now. Committing it is the approval.
- Each tool carries a `class` (`read`, `write`, `destructive`) from the lockfile: on the exchange of a proxy route as `McpHeadersKeys.CLASS`, on `McpToolRegistryEntry.class`, and on the tool a star route's `schemas` and `exclude` functions are handed. It is `destructive` for anything served without approval, and for a pinned client the tool's tags come from it instead of the server's annotations.
- `plugin:mcp:pin:held`, `plugin:mcp:pin:changed` and `plugin:mcp:pin:removed` report a tool leaving its approved state.
- A star proxy's `exclude` also takes `(tool) => boolean`.
- `mcp({ proxy })` types its options by the form of the ref: `exclude` and `schemas` beside an exact ref, or `name` and `annotations` beside a star ref, are now type errors as well as the start-time `RC5003` they already were. A ref typed as `string` is checked when `mcp()` is called, as before.
