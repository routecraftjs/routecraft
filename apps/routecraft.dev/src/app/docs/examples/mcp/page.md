---
title: MCP tool
---

Expose a capability as an MCP tool, and call a remote MCP server from a capability. {% .lead %}

MCP is a two-sided adapter. The same `mcp()` adapter turns a capability into a tool an agent
can call (source mode), and lets a capability call a tool on a remote MCP server (destination
mode). This page shows both. The runnable source lives at
[`examples/src/mcp-greet.ts`](https://github.com/routecraftjs/routecraft/blob/main/examples/src/mcp-greet.ts).

## Expose a capability as an MCP tool

Use `mcp()` as the source. The tool name is the route's `.id()`; the AI-facing
`.description()` and the `.input()` schema live on the builder, and Routecraft validates every
call against the schema before the pipeline runs.

```ts
// capabilities/greet-user.ts
import { craft, log, noop } from '@routecraft/routecraft'
import { mcp } from '@routecraft/ai'
import { z } from 'zod'

const GreetInput = z.object({
  user: z.string().trim().min(1, { message: 'User is required.' }).describe('The user to greet.'),
})
type GreetInput = z.infer<typeof GreetInput>

export default craft()
  .id('greet-user')
  .title('Greet user')
  .description('Greet a user by name')
  .input({ body: GreetInput })
  .from(mcp())
  .tap(log())
  .transform((payload) => ({ message: `Hello, ${payload.user}!` }))
  .to(noop())
```

Run it with `craft run ./capabilities/greet-user.ts` and point an AI client at the process.
See [Running an MCP server](/docs/advanced/expose-as-mcp) for transports and client wiring,
and [Securing capabilities](/docs/advanced/securing-capabilities) when you serve it over HTTP.

## Call an external MCP server

Register the remote servers on `mcpPlugin({ clients })`, then call any tool with the
`server:tool` shorthand. `.to()` replaces the body with the tool result; `.enrich()` merges it.

```ts
// craft.config.ts
import { mcpPlugin } from '@routecraft/ai'
import type { CraftConfig } from '@routecraft/routecraft'

export default {
  plugins: [mcpPlugin({ clients: { search: { url: 'http://127.0.0.1:9000/mcp' } } })],
} satisfies CraftConfig
```

```ts
// capabilities/web-search.ts
import { craft, simple, log } from '@routecraft/routecraft'
import { mcp } from '@routecraft/ai'

export default craft()
  .id('web.search')
  .from(simple({ query: 'Routecraft documentation' }))
  .to(mcp('search:web_search'))
  .to(log())
```

See [Calling an MCP](/docs/advanced/call-an-mcp) for custom argument mapping and inline-URL
calls, and the [`mcp()` adapter reference](/docs/reference/adapters/mcp) for the full option
surface on both sides.

---

## Related

{% quick-links %}

{% quick-link title="Running an MCP server" icon="plugins" href="/docs/advanced/expose-as-mcp" description="Transports, client wiring, and server identity." /%}
{% quick-link title="Calling an MCP" icon="plugins" href="/docs/advanced/call-an-mcp" description="Call external MCP servers from within a capability." /%}
{% quick-link title="mcp() adapter reference" icon="presets" href="/docs/reference/adapters/mcp" description="Full MCP adapter API and options." /%}

{% /quick-links %}
