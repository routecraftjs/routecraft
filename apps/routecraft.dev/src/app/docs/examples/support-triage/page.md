---
title: Support triage agent
---

Let an agent triage incoming support email, bounded to a two-tool allowlist. {% .lead %}

This is the "whole agent" mode: the capability is the agent loop. A support email arrives over
IMAP, and an `agent()` destination reads it, looks the customer up, decides a priority, and
posts an internal brief. The agent is the brain, but it has **hands, not keys**: it can call
exactly two capabilities and nothing else, no arbitrary HTTP, no shell, no open-ended tools.

## The bounded tools

Each tool is an ordinary capability with a `direct()` source, a description (the agent reads
it to decide when to call), and a typed input. Because they are normal capabilities, they are
testable and reusable on their own.

```ts
// capabilities/support/lookup-customer/route.ts
import { craft, direct, http } from '@routecraft/routecraft'
import { z } from 'zod'

export const LookupInput = z.object({ email: z.string().email() })
export type LookupInput = z.infer<typeof LookupInput>

export default craft()
  .id('lookup-customer')
  .description('Look up a customer and their plan by email address')
  .input({ body: LookupInput })
  .from<LookupInput>(direct())
  .to(http({ method: 'GET', url: (ex) => `https://api.example.com/customers/${ex.body.email}` }))
```

```ts
// capabilities/support/post-brief/route.ts
import { craft, direct, http } from '@routecraft/routecraft'
import { z } from 'zod'

export const BriefInput = z.object({
  priority: z.enum(['P1', 'P2', 'P3']),
  customer: z.string(),
  summary: z.string(),
})
export type BriefInput = z.infer<typeof BriefInput>

export default craft()
  .id('post-brief')
  .description('Post a triage brief to the internal support channel')
  .input({ body: BriefInput })
  .from<BriefInput>(direct())
  .to(http({ method: 'POST', url: 'https://chat.example.com/support/briefs' }))
```

## The agent

The triage capability sources from the inbox and hands each message to `agent()`. The
`tools([...])` allowlist is the guardrail: `Direct(lookup-customer)` and `Direct(post-brief)`
are the only tools the model can call.

```ts
// capabilities/support/triage/route.ts
import { craft, mail } from '@routecraft/routecraft'
import { agent, tools } from '@routecraft/ai'

export default craft()
  .id('triage-support')
  .description('Triage an incoming support email')
  .from(mail('INBOX', { unseen: true, markSeen: true }))
  .to(
    agent({
      model: 'anthropic:claude-sonnet-4-6',
      system:
        'You are a support triage assistant. Look the sender up, decide a priority (P1 urgent, P2 normal, P3 low), and post one concise internal brief. Do not reply to the customer.',
      user: (ex) => `From: ${ex.body.from}\nSubject: ${ex.body.subject}\n\n${ex.body.text}`,
      tools: tools(['Direct(lookup-customer)', 'Direct(post-brief)']),
    }),
  )
```

`Direct(<id>)` references a registered capability as a tool; the agent sees its
`.description()` and `.input()` schema and calls it with validated arguments. `CurrentTime` and
`MCP(server:tool)` are also valid allowlist entries, and the object form
`{ name, guard, description }` adds a per-tool [guard](/docs/advanced/securing-capabilities) or
a per-agent description override. A guard receives the tool input and a context carrying the
caller's principal, and throws to deny the call:

```ts
tools([
  'Direct(lookup-customer)',
  {
    name: 'Direct(post-brief)',
    guard: (_input, ctx) => {
      if (!ctx.principal?.roles?.includes('support')) throw new Error('not authorised to post briefs')
    },
  },
])
```

## Config

Model providers live on `llmPlugin`; the mail account is configured where you set up the
`mail` adapter. The agent inherits the provider from the plugin.

```ts
// craft.config.ts
import { llmPlugin } from '@routecraft/ai'
import type { CraftConfig } from '@routecraft/routecraft'

export default {
  plugins: [llmPlugin({ providers: { anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! } } })],
} satisfies CraftConfig
```

## Giving the agent durable context

For standing instructions the agent should always have (tone, escalation policy, product
facts), attach `blocks` instead of stuffing the `system` string. `skills(...)` loads markdown
files as blocks; by default they are surfaced progressively (the model sees each skill's name
and description and loads the body via a tool call only when relevant). It is async, so resolve
it once and assign it to a named group so every skill stays under one key:

```ts
import { agent, tools, skills } from '@routecraft/ai'

const supportKnowledge = await skills({ source: './support-knowledge' })

agent({
  model: 'anthropic:claude-sonnet-4-6',
  system: 'You are a support triage assistant.',
  blocks: { knowledge: supportKnowledge },
  tools: tools(['Direct(lookup-customer)', 'Direct(post-brief)']),
})
```

Each skill then resolves to `knowledge__<skill-name>` (its loader tool and `blocksLoaded`
entry). Spreading `...supportKnowledge` still works if you would rather keep each skill at the
top level.

---

## Related

{% quick-links %}

{% quick-link title="agent() adapter reference" icon="presets" href="/docs/reference/adapters/agent" description="Model, system, tools, blocks, and loop options." /%}
{% quick-link title="Securing capabilities" icon="plugins" href="/docs/advanced/securing-capabilities" description="Guards, principals, and authorizing what an agent can reach." /%}
{% quick-link title="MCP tool" icon="installation" href="/docs/examples/mcp" description="Expose a capability as a tool an external agent can call." /%}

{% /quick-links %}
