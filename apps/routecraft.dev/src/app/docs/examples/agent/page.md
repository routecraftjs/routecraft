---
title: Agent step
---

Route a capability's output into an LLM agent with bounded tools. {% .lead %}

`greet-user` receives input over `direct()` and hands it to an `agent()` destination: a model
with a system prompt and an explicit, bounded tool allowlist. Source:
[`examples/src/agent.ts`](https://github.com/routecraftjs/routecraft/blob/main/examples/src/agent.ts).

```ts
import { craft, direct, simple } from '@routecraft/routecraft'
import { agent, tools } from '@routecraft/ai'
import { z } from 'zod'

const GreetInput = z.object({ user: z.string().trim().min(1) })
type GreetInput = z.infer<typeof GreetInput>

export default craft()
  .id('call')
  .from(simple({ user: 'Jaco' }))
  .to(direct('greet-user'))

  .id('greet-user')
  .title('Greet user')
  .description('Greet a user by name')
  .input({ body: GreetInput })
  .from<GreetInput>(direct())
  .to(
    agent({
      model: 'gemini:gemini-3.1-pro-preview',
      system: 'Format time and date at 5 June 2026 08:30',
      user: () => 'What is the current time?',
      tools: tools(['currentTime']),
    }),
  )
  .log()
```

`agent()` makes the capability the brain of an agent loop. `tools(['currentTime'])` is the
bounded allowlist: the agent can only call the tools you name, which is the guardrail that
keeps an agent step from turning into an open-ended one. This example needs an agent model
configured (and its API key in `.env`), so it is not part of the default examples run.

---

## Related

{% quick-links %}

{% quick-link title="agent() adapter reference" icon="presets" href="/docs/reference/adapters/agent" description="Model, system prompt, tools, and loop options." /%}
{% quick-link title="MCP tool" icon="installation" href="/docs/examples/mcp" description="Expose a capability as a tool an agent can call." /%}

{% /quick-links %}
