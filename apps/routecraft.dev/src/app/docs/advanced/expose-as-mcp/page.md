---
title: Expose as MCP
---

Run your capabilities as MCP tools for Claude, Cursor, and other AI clients. {% .lead %}

## How it works

RouteCraft uses the Model Context Protocol (MCP) to expose capabilities as typed tools. You define the tool as a capability using the `mcp()` source adapter, run it with `craft run`, and point your AI client at the process. The AI can then call your tool with validated inputs -- nothing else is accessible.

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

## Configure Claude Desktop

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

Restart Claude Desktop completely after saving. Look for the hammer icon in the input area -- your capabilities will appear in the tool picker.

## Configure Cursor

Open **Cursor Settings** → **Features** → **Model Context Protocol**, then add:

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

- **Validate all inputs** -- every capability should have a Zod schema; RouteCraft enforces it before execution
- **Guardrails** -- use `.filter()` to reject exchanges that fail a business rule, and `.transform()` to sanitize or normalise values before they reach downstream systems
- **Principle of least privilege** -- only expose capabilities the AI actually needs
- **Audit trail** -- add `.tap(log())` to record every invocation
- **Never hardcode credentials** -- use `process.env` and `.env` files

---

## Related

{% quick-links %}

{% quick-link title="Call an MCP" icon="plugins" href="/docs/advanced/call-an-mcp" description="Call external MCP servers from within a capability." /%}
{% quick-link title="AI Package reference" icon="presets" href="/docs/reference/ai" description="Full MCP adapter API and options." /%}

{% /quick-links %}
