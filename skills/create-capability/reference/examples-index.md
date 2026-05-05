# Capability examples index

Pick the row that best matches the user's intent. Then `WebFetch` both URLs in that row before writing.

| If the user wants... | Read this doc | Then study this example |
|---|---|---|
| The simplest possible capability (in-memory source, transform, log destination) | https://routecraft.dev/raw/docs/introduction/operations.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/examples/src/hello-world.ts (multi-purpose: also covers direct-call routing and HTTP enrichment) |
| Direct-call routing between two capabilities (one capability invokes another by id) | https://routecraft.dev/raw/docs/reference/adapters.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/examples/src/hello-world.ts (the same file; focus on the `direct(...)` source and the second capability calling the first by id) |
| HTTP enrichment (call an API mid-pipeline and merge the result into the body) | https://routecraft.dev/raw/docs/reference/operations.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/examples/src/hello-world.ts (the same file; focus on the `.enrich(http(...))` step) |
| Split a collection, process each item, then aggregate (fan-out / fan-in) | https://routecraft.dev/raw/docs/reference/operations.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/examples/src/split.ts |
| Filter and validate before transform (per-item rejection with a reason) | https://routecraft.dev/raw/docs/reference/operations.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/examples/src/split.ts |
| Expose a capability as an MCP tool callable by AI agents | https://routecraft.dev/raw/docs/advanced/expose-as-mcp.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/examples/src/mcp-greet.ts |
| Call an LLM inside a capability (agent step) | https://routecraft.dev/raw/docs/advanced/call-an-mcp.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/examples/src/agent.ts |
| Mail inbox watcher (IMAP source) plus mail sender (SMTP destination) | https://routecraft.dev/raw/docs/reference/adapters.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/examples/src/mail-noreply-notify.ts |
| File to HTTP synchronisation (read a file, post each row to an API) | https://routecraft.dev/raw/docs/examples/api-sync.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/examples/src/split.ts |

## How to choose

Filter on **shape of the pipeline** first, **trigger** second, **destinations** third:

1. Linear vs split/aggregate vs choice -- this picks the example
2. What triggers the capability (direct, MCP, mail, simple) -- this picks the source adapter
3. Where the result goes (log, http, mail, direct) -- this picks the destination adapter

If no row is a clean match, pick by pipeline shape and adapt the source and destination to the user's case.
