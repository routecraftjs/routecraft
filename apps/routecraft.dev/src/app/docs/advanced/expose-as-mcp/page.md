---
title: Expose as MCP
---

Run your capabilities as MCP tools for Claude, Cursor, and other AI clients. {% .lead %}

## How it works

Routecraft uses the Model Context Protocol (MCP) to expose capabilities as typed tools. You define the tool as a capability using the `mcp()` source adapter, run it with `craft run`, and point your AI client at the process. The AI can then call your tool with validated inputs -- nothing else is accessible.

## Install

```bash
npm install @routecraft/ai zod
```

## Define a capability

A capability becomes an MCP tool when you use `mcp()` as its source. Give it a `description` the AI uses to decide when to call it, and a Zod `schema` for the input.

```ts
// capabilities/search-orders.ts
import { mcp } from '@routecraft/ai'
import { craft, http } from '@routecraft/routecraft'
import { z } from 'zod'

export default craft()
  .id('orders.search')
  .from(mcp('orders.search', {
    description: 'Search orders by customer ID or date range',
    schema: z.object({
      customerId: z.string().optional(),
      from: z.string().date().optional(),
      to: z.string().date().optional(),
    }),
    keywords: ['orders', 'search'],
  }))
  .transform(({ customerId, from, to }) => buildQuery(customerId, from, to))
  .to(http({ method: 'GET', path: '/orders' }))
```

The `schema` is validated before the capability runs. Invalid inputs are rejected with a structured error before any business logic executes.

## Stdio transport (default)

Stdio is the simplest transport. The AI client spawns Routecraft as a subprocess and communicates over stdin/stdout. No networking, no auth required.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "my-tools": {
      "command": "npx",
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
    "command": "npx",
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
      "command": "npx",
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
      auth: jwt({ secret: process.env.JWT_SECRET! }),
    }),
  ],
}
```

Start the server with `craft run`, then point your AI client at it.

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

## Authentication

When using HTTP transport, secure the endpoint with the `auth` option. Routecraft ships with a built-in `jwt()` helper that verifies JWT signatures using `node:crypto` (zero dependencies).

```ts
import { jwt } from '@routecraft/ai'

// HMAC (HS256, default)
auth: jwt({ secret: process.env.JWT_SECRET! })

// RSA (RS256)
auth: jwt({
  algorithm: 'RS256',
  publicKey: fs.readFileSync('./public.pem', 'utf-8'),
})
```

For other auth schemes, pass a custom `validator` function:

```ts
auth: {
  validator: async (token) => {
    const user = await db.verifyApiKey(token)
    if (!user) return null
    return { subject: user.id, scheme: 'api-key', roles: user.roles }
  },
}
```

The validator receives the raw bearer token and returns an `AuthPrincipal` on success or `null` to reject with 401. The principal's fields (`subject`, `scheme`, `roles`, etc.) are set as exchange headers so your routes can read the caller's identity.

See the [plugins reference](/docs/reference/plugins#mcpplugin) for the full `AuthPrincipal` field list.

## Production

Pin the CLI version so your capabilities do not break on package updates:

```json
{
  "mcpServers": {
    "my-tools": {
      "command": "npx",
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

## Security

- **Validate all inputs** -- every capability should have a Zod schema; Routecraft enforces it before execution
- **Authenticate HTTP endpoints** -- always set `auth` when using HTTP transport in production
- **Guardrails** -- use `.filter()` to reject exchanges that fail a business rule, and `.transform()` to sanitize or normalise values before they reach downstream systems
- **Principle of least privilege** -- only expose capabilities the AI actually needs
- **Audit trail** -- add `.tap(log())` to record every invocation; subscribe to `plugin:mcp:tool:**` events for MCP-specific tracing
- **Never hardcode credentials** -- use `process.env` and `.env` files

---

## Related

{% quick-links %}

{% quick-link title="Call an MCP" icon="plugins" href="/docs/advanced/call-an-mcp" description="Call external MCP servers from within a capability." /%}
{% quick-link title="AI Package reference" icon="presets" href="/docs/reference/ai" description="Full MCP adapter API and options." /%}

{% /quick-links %}
