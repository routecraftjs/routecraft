---
"@routecraft/ai": minor
---

**Breaking:** a remote MCP server is reached over `https`, and what it sends back is given less room.

- A client `url` or an inline `mcp({ url })` over plain `http` is refused with `RC5003` unless the host is loopback (`localhost`, an address in `127.0.0.0/8`, `[::1]`) or the client or call sets the new `allowHttp: true`. A registered client that is enabled fails when the plugin binds, and `craft connect` refuses the login.
- The `resource_metadata` URL in a `401` no longer chooses where a `connect()` client's discovery goes.
- The `AI2003` message no longer carries the remote's error text, which keeps it out of logs and out of `plugin:mcp:tool:failed`. The MCP caller of a proxy route and an agent's model still receive it, and a route reads it with the new `remoteErrorTextOf(error)`.

**Breaking (canary only):** on a star proxy route, `.title()`, `.description()`, a hint tag (`read-only`, `destructive`, `idempotent`, `open-world`) and `mcp({ annotations })` fail at start with `RC5003` instead of replacing what every tool of the client says about itself (#914). Two proxy routes that would expose one tool name now expose neither, logged at error level, where the first used to keep it.
