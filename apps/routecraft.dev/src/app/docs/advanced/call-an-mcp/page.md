---
title: Call an MCP
---

Call tools on external MCP servers from within a capability. {% .lead %}

## How it works

The `mcpPlugin` connects your RouteCraft context to one or more remote MCP servers. Once registered, you can call any tool on those servers using `.to(mcp('server:tool'))` or `.enrich(mcp('server:tool'))` inside any capability.

## Install

```bash
npm install @routecraft/ai
```

## Register remote servers

Add `mcpPlugin` to your `craft.config.ts` and list the servers your capabilities need to reach:

```ts
// craft.config.ts
import { mcpPlugin } from '@routecraft/ai'
import type { CraftConfig } from '@routecraft/routecraft'

const config: CraftConfig = {
  plugins: [
    mcpPlugin({
      clients: {
        browser: { url: 'http://127.0.0.1:8089/mcp' },
        search: { url: 'http://127.0.0.1:9000/mcp' },
      },
    }),
  ],
}

export default config
```

Each key under `clients` is the server alias you use in your capabilities.

## Call a tool

Use the `server:tool` shorthand in `.to()` to send the exchange body as tool arguments and replace it with the result:

```ts
// capabilities/web-search.ts
import { mcp } from '@routecraft/ai'
import { craft, simple, log } from '@routecraft/routecraft'

export default craft()
  .id('web.search')
  .from(simple({ query: 'RouteCraft documentation' }))
  .to(mcp('search:web_search'))
  .to(log())
```

Or use `.enrich()` to merge the result into the exchange body instead of replacing it:

```ts
export default craft()
  .id('orders.enrich')
  .from(http({ path: '/orders/:id', method: 'GET' }))
  .enrich(mcp('search:lookup_customer'))
  .to(http({ method: 'POST', path: '/crm/orders' }))
```

## Custom argument mapping

By default, the exchange body is passed as-is to the tool. Use the `args` option to map the body to the exact shape the tool expects:

```ts
.to(mcp('browser:navigate', {
  args: (exchange) => ({ url: exchange.body.targetUrl }),
}))
```

## Full URL (no plugin required)

If you only need to call a single external tool and do not want to register it globally, pass the URL directly:

```ts
.to(mcp({ url: 'http://127.0.0.1:8089/mcp', tool: 'navigate' }))
```

---

## Related

{% quick-links %}

{% quick-link title="Expose as MCP" icon="plugins" href="/docs/advanced/expose-as-mcp" description="Run your own capabilities as MCP tools for AI clients." /%}
{% quick-link title="AI Package reference" icon="presets" href="/docs/reference/ai" description="Full MCP adapter API and options." /%}

{% /quick-links %}
