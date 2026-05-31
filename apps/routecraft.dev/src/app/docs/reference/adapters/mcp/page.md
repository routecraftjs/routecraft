---
title: mcp
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
import { mcp } from '@routecraft/ai'
```

Expose capabilities as MCP tools or call remote MCP servers. Requires `mcpPlugin()` in your context plugins when used as a source.

**Source mode -- define a discoverable MCP tool:**

The tool name is the route id; the tool's title, description, and schemas live on the route builder (enforced framework-wide). Only MCP-protocol extras (`annotations`, `icons`) remain on `mcp()` itself.

```ts
import { mcp } from '@routecraft/ai'
import { z } from 'zod'

craft()
  .id('fetch-webpage')
  .title('Fetch webpage')
  .description('Fetch the content of a webpage')
  .input({ body: z.object({ url: z.string().url() }) })
  .output({ body: z.object({ content: z.string() }) })
  .from(mcp({ annotations: { readOnlyHint: true, openWorldHint: true } }))
  .transform(async ({ url }) => {
    const res = await fetch(url)
    return { content: await res.text() }
  })
```

A non-empty `.description()` is required for every MCP source route (surfaced as the tool description in `tools/list`); the route fails to subscribe otherwise. The tool name (route id) is validated against the MCP interop regex `^[A-Za-z0-9_-]{1,64}$`.

**Destination mode -- call a remote MCP tool:**

```ts
// Recommended: by server id registered in mcpPlugin({ clients }).
// Auth is inherited from the client config automatically.
.enrich(mcp('browser:browser_navigate', { args: (ex) => ({ url: ex.body.url }) }))

// By URL and tool name (use inline auth if needed)
.enrich(mcp({ url: 'http://127.0.0.1:8089/mcp', tool: 'browser_navigate' }, { args: (ex) => ({ url: ex.body.url }) }))
```

When using the `serverId` path (recommended), auth configured on the client in `mcpPlugin({ clients })` flows to the destination automatically. Inline `auth` on `McpClientOptions` is available as an escape hatch for the raw `url` path or to override registered config, but prefer centralizing credentials in the plugin config.

**Options (McpServerOptions -- source, protocol extras only):**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `annotations` | `McpToolAnnotations` | No | Behavior hints forwarded to MCP clients in the `tools/list` response |
| `icons` | `McpToolIcon[]` | No | Icons forwarded on `tools/list` per the MCP spec |

All other tool metadata (title, description, input / output schemas) comes from the route builder and is enforced framework-wide:

| Builder method | Maps to | Notes |
|----------------|---------|-------|
| `.id('tool-name')` | `tool.name` | Validated against `^[A-Za-z0-9_-]{1,64}$` at subscribe |
| `.title('...')` | `tool.title` | Optional display title |
| `.description('...')` | `tool.description` | **Required** for MCP source routes |
| `.input({ body, headers })` | `tool.inputSchema` + runtime check | `body` validation is framework-enforced; `headers` validated values merge over the originals |
| `.output({ body, headers })` | `tool.outputSchema` + runtime check | Framework-enforced before the primary destination fires |

**McpToolAnnotations (optional hint fields, all booleans unless noted):**

These mirror the [MCP specification (2025-03-26) `ToolAnnotations`](https://modelcontextprotocol.io/specification/2025-03-26/server/tools#annotations) shape. They are hints only; clients must not rely on them for correctness or safety.

| Field | Type | Description |
|-------|------|-------------|
| `title` | `string` | Human-readable title for the tool (used for display in UIs). |
| `readOnlyHint` | `boolean` | When `true`, the tool does not modify any state. Clients assume `false` when omitted. |
| `destructiveHint` | `boolean` | When `true`, the tool may perform destructive operations. Clients assume `true` when omitted. |
| `idempotentHint` | `boolean` | When `true`, calling the tool repeatedly with the same arguments has no additional effect. Clients assume `false` when omitted. |
| `openWorldHint` | `boolean` | When `true`, the tool may interact with external systems (network, filesystem, etc.). Clients assume `true` when omitted. |

**Options (McpClientOptions -- destination):**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `url` | `string` | One of url/serverId | Direct HTTP URL of the remote MCP server |
| `serverId` | `string` | One of url/serverId | Named server registered via `mcpPlugin({ clients })` |
| `tool` | `string` | No | Tool name to invoke (or set `exchange.body.tool`) |
| `args` | `(exchange) => Record<string, unknown>` | No | Extractor for tool arguments; defaults to `exchange.body` |
| `auth` | `McpClientAuthOptions` | No | Auth credentials for HTTP requests. Auto-inherited from `mcpPlugin({ clients })` when using `serverId`; use to override or for inline `url` connections |

**McpClientAuthOptions:**

| Field | Type | Description |
|-------|------|-------------|
| `token` | `string \| string[] \| (() => string \| Promise<string>)` | Bearer token, array of tokens (round-robin), or provider function called per request |
| `headers` | `Record<string, string>` | Additional request headers; overrides `token` if `Authorization` is set |

#### Tool Registry

Each `.from(mcp(...))` route registers in `MCP_LOCAL_TOOL_REGISTRY` so the MCP server can list and invoke it via the MCP protocol:

```ts
import { MCP_LOCAL_TOOL_REGISTRY } from '@routecraft/ai'

const ctx = await new ContextBuilder().routes(...).build()
await ctx.start()

const registry = ctx.getStore(MCP_LOCAL_TOOL_REGISTRY)
const tools = registry ? Array.from(registry.values()) : []
// [{ endpoint, title?, description, input?, output?, annotations?, icons?, handler }]
```

`mcp()` and `direct()` maintain separate, fully isolated registries. An MCP route with `.id('foo').from(mcp())` and a direct route with `.id('bar').from(direct())` both register by their own ids in their own stores; direct routes never appear in the MCP `tools/list` response.

See [Running an MCP server](/docs/advanced/expose-as-mcp), [Calling an MCP](/docs/advanced/call-an-mcp), and the [MCP example](/docs/examples/mcp).
