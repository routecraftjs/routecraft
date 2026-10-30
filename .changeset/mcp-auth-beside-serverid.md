---
"@routecraft/ai": minor
---

`mcp()` refuses `auth` beside a `serverId` with `RC5003`.

A registered client is one identity, so a `serverId` call sends the auth registered on the client in `mcpPlugin({ clients })`. An `auth` passed beside `serverId`, in `mcp({ serverId, tool, auth })` or in the `'server:tool'` shorthand, was silently ignored although the docs said it overrode the registered auth. It is now refused when `mcp()` is called. A credential the route owns goes on an inline `mcp({ url, tool, auth })` call, which is unchanged.
