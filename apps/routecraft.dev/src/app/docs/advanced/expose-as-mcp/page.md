---
title: Running an MCP server
---

Run your capabilities as MCP tools for Claude, Cursor, and other AI clients. {% .lead %}

## How it works

Routecraft uses the Model Context Protocol (MCP) to expose capabilities as typed tools. You define the tool as a capability using the `mcp()` source adapter, run it with `craft run`, and point your AI client at the process. The AI can then call your tool with validated inputs -- nothing else is accessible.

A capability becomes an MCP tool when you use `mcp()` as its source: the tool name is the route's `.id()`, and the `.description()` and `.input()` schema live on the route builder so Routecraft can validate every call before any business logic runs. See the [MCP example](/docs/examples/mcp) for a complete, copyable capability, and the [`mcp()` adapter reference](/docs/reference/adapters/mcp) for the full option surface.

## Install

```bash
bun add @routecraft/ai zod
```

## Stdio transport (default)

Stdio is the simplest transport. The AI client spawns Routecraft as a subprocess and communicates over stdin/stdout. No networking, no auth required.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "my-tools": {
      "command": "bunx",
      "args": [
        "@routecraft/cli",
        "run",
        "./capabilities/search-orders.ts"
      ]
    }
  }
}
```

Restart Claude Desktop completely after saving. Look for the hammer icon in the input area.

### Cursor

Open **Cursor Settings** > **Features** > **Model Context Protocol**, then add:

```json
{
  "my-tools": {
    "command": "bunx",
    "args": [
      "@routecraft/cli",
      "run",
      "./capabilities/search-orders.ts"
    ]
  }
}
```

### Claude Code

Add the following to your `.mcp.json` (project-level) or `~/.claude/mcp.json` (global):

```json
{
  "mcpServers": {
    "my-tools": {
      "command": "bunx",
      "args": [
        "@routecraft/cli",
        "run",
        "./capabilities/search-orders.ts"
      ]
    }
  }
}
```

## HTTP transport

Use the HTTP transport when you want a long-running server that multiple clients can connect to, or when you need authentication. Add `mcpPlugin` to your config with `transport: 'http'`:

```ts
// craft.config.ts
import { mcpPlugin, jwt } from '@routecraft/ai'

export default {
  plugins: [
    mcpPlugin({
      transport: 'http',
      port: 3001,
      auth: jwt({
        secret: process.env.JWT_SECRET!,
        issuer: 'https://idp.example.com',
        audience: 'https://mcp.example.com',
      }),
    }),
  ],
}
```

Start the server with `craft run`, then point your AI client at it. Anything reachable over the network must be authenticated: see [Securing capabilities](/docs/advanced/securing-capabilities) for every auth mode (`jwt()`, `jwks()`, custom validators, the OAuth 2.1 proxy), identity enrichment, RFC 9728 discovery metadata, and CORS.

### Claude Desktop (HTTP)

```json
{
  "mcpServers": {
    "my-tools": {
      "url": "http://localhost:3001/mcp",
      "headers": {
        "Authorization": "Bearer <your-jwt-token>"
      }
    }
  }
}
```

### Cursor (HTTP)

```json
{
  "my-tools": {
    "url": "http://localhost:3001/mcp",
    "headers": {
      "Authorization": "Bearer <your-jwt-token>"
    }
  }
}
```

### Claude Code (HTTP)

```json
{
  "mcpServers": {
    "my-tools": {
      "url": "http://localhost:3001/mcp",
      "headers": {
        "Authorization": "Bearer <your-jwt-token>"
      }
    }
  }
}
```

## Server identity and branding

When a client like Claude adds your server, it renders the server's identity from the MCP `initialize` handshake. Configure it on `mcpPlugin` (or the `mcp` key of `defineConfig`):

```ts
// craft.config.ts
import { mcpPlugin } from '@routecraft/ai'

export default {
  plugins: [
    mcpPlugin({
      name: 'acme-bot',                          // serverInfo.name (machine id)
      title: 'Acme Bot',                         // serverInfo.title (display name)
      version: '2.1.0',                          // serverInfo.version
      description: 'Acme operations over MCP.',  // serverInfo.description
      websiteUrl: 'https://acme.example.com',    // serverInfo.websiteUrl
      instructions: 'Call orders_search before orders_refund.', // initialize.instructions
      icons: [
        { src: 'https://acme.example.com/icon.svg', mimeType: 'image/svg+xml' },
        { src: 'data:image/png;base64,...', mimeType: 'image/png', sizes: ['48x48'], theme: 'light' },
      ],
    }),
  ],
}
```

`instructions` is server-wide guidance the client may add to the model's context (advisory per the spec). It complements each tool's own `.description()`, which is the per-tool equivalent.

### Defaults and how to opt out

When you do not set them, Routecraft fills in a "powered by Routecraft" identity. Each default is overridable with your own value or suppressible with an empty value:

| Field | Default when unset | Suppress with |
| --- | --- | --- |
| `icons` | Routecraft logo (light and dark variants) | `icons: []` |
| `description` | `"Powered by Routecraft.dev"` | `description: ""` |
| `websiteUrl` | `"https://routecraft.dev"` | `websiteUrl: ""` |
| `instructions` | none (omitted) | `instructions: ""` |

### Per-tool icons and inheritance

A capability can carry its own icon via the `mcp()` source. The icon shape follows the MCP `Icon` spec (`src`, optional `mimeType`, `sizes` as a string array, and an optional `theme`):

```ts
craft()
  .id('orders_search')
  .description('Search orders')
  .from(mcp({
    annotations: { readOnlyHint: true },
    icons: [{ src: 'https://acme.example.com/search.svg', mimeType: 'image/svg+xml', sizes: ['48x48'] }],
  }))
```

Icons resolve with the same rule at both levels: omit `icons` to inherit (a tool with no icon of its own shows the server's icon, including the Routecraft default), set `icons: [...]` for a custom icon, or set `icons: []` to show none.

## Production

Pin the CLI version so your capabilities do not break on package updates:

```json
{
  "mcpServers": {
    "my-tools": {
      "command": "bunx",
      "args": [
        "@routecraft/cli@2.0.0",
        "run",
        "/absolute/path/to/capabilities/search-orders.ts"
      ]
    }
  }
}
```

Use absolute paths in production to avoid working-directory ambiguity.

---

## Related

{% quick-links %}

{% quick-link title="Securing capabilities" icon="plugins" href="/docs/advanced/securing-capabilities" description="Authenticate HTTP endpoints, enrich identity, RFC 9728, CORS." /%}
{% quick-link title="MCP tool" icon="installation" href="/docs/examples/mcp" description="A copyable capability exposed as an MCP tool." /%}
{% quick-link title="Calling an MCP" icon="plugins" href="/docs/advanced/call-an-mcp" description="Call external MCP servers from within a capability." /%}
{% quick-link title="mcp() adapter reference" icon="presets" href="/docs/reference/adapters/mcp" description="Full MCP adapter API and options." /%}

{% /quick-links %}
