---
title: Calling an MCP
---

Call tools on external MCP servers from within a capability. {% .lead %}

## How it works

The `mcpPlugin` connects your Routecraft context to one or more remote MCP servers. Once registered, you can call any tool on those servers using `.to(mcp('server:tool'))` or `.enrich(mcp('server:tool'))` inside any capability.

## Install

```bash
bun add @routecraft/ai
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
  .from(simple({ query: 'Routecraft documentation' }))
  .to(mcp('search:web_search'))
  .to(log())
```

Or use `.enrich()` to merge the result into the exchange body instead of replacing it:

```ts
export default craft()
  .id('orders.enrich')
  .from(http({ path: '/orders/:id', method: 'GET' }))
  .enrich(mcp('search:lookup_customer'))
  .to(http({ method: 'POST', url: 'https://crm.example.com/orders' }))
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

## Guardrails: raw, guarded, or wrapped

A raw MCP tool carries no per-call policy. When an agent calls one, the credentials registered on the client are what reach the server; the agent does not forward the caller's principal to the MCP hop (this keeps the two trust boundaries separate -- see [Securing capabilities](/docs/advanced/securing-capabilities)). So a raw tool has no identity check, no caching, and no timeout of its own. You add those on the Routecraft side, and there are three tiers to choose from.

**Pick the lowest tier that covers what you need.** The moment you need caching, a timeout, throttling, retry, a fallback, or an audit trail, you are at tier 3: a guard is a single predicate with no state and no clock, so it can answer "may John call this?" but it cannot hold a cache or a deadline.

| You need | Use | Cost | Reusable |
|---|---|---|---|
| A read-only or otherwise harmless tool, trusted agent | raw `MCP(server:tool)` | nothing | n/a |
| To block by identity or role, a pure yes/no | a per-tool `guard` on the binding | one inline function | no, per binding |
| Anything stateful or time-based, or shared across agents | wrap the tool in a route, hand the agent `Direct(<id>)` | a few lines | yes |

Tiers 1 and 2 are covered on the [agent plugin reference](/docs/reference/plugins/agentplugin). For tier 3, put a route in front of the tool: its entry is a `direct()` endpoint, its exit is the `.to(mcp(...))` call you have already seen, and the guardrails live on the steps between.

```ts
// capabilities/github/create-issue.ts
import { mcp } from '@routecraft/ai'
import { craft, direct } from '@routecraft/routecraft'

export default craft()
  .id('github.create-issue')
  .from(direct())
  .authorize({ roles: ['maintainer'] }) // per-call principal check
  .to(mcp('github:create_issue'))
```

Hand the agent the governed route instead of the raw tool. The same underlying tool can be exposed both ways: wrap the ones that need policy (one route per tool), leave harmless read-only tools raw.

```ts
agent({
  tools: tools([
    'Direct(github.create-issue)', // governed: authorized and auditable
    'MCP(github:list_issues)',     // raw: read-only, fine ungoverned
  ]),
})
```

Why a route and not a richer guard? A guard runs once and holds no state. Caching, timeouts, throttling, retries, and fallbacks each need something wrapped around the call with its own state and lifecycle, which is exactly what a route step is. Today a wrapped route gives you [`authorize()`](/docs/reference/operations/authorize), [`error()`](/docs/reference/operations/error) fallbacks, and `.tap(log())` for an audit trail immediately. [`cache()`](/docs/reference/operations/cache), [`timeout()`](/docs/reference/operations/timeout), [`throttle()`](/docs/reference/operations/throttle), and [`retry()`](/docs/reference/operations/retry) are planned; when they ship they drop onto the same route with no change to how the agent consumes the tool. The route is the only place that behaviour can ever live.

---

## Related

{% quick-links %}

{% quick-link title="Running an MCP server" icon="plugins" href="/docs/advanced/expose-as-mcp" description="Run your own capabilities as MCP tools for AI clients." /%}
{% quick-link title="MCP tool" icon="installation" href="/docs/examples/mcp" description="A copyable capability exposed as an MCP tool." /%}
{% quick-link title="mcp() adapter reference" icon="presets" href="/docs/reference/adapters/mcp" description="Full MCP adapter API and options." /%}

{% /quick-links %}
