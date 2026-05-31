---
title: Programmatic invocation
---

Dispatch into capabilities from your own code instead of the CLI. {% .lead %}

Build a context yourself and use the returned `client` to call `direct()` capabilities from
any framework (Commander, Express, Next.js). This example wires a Commander CLI. Source:
[`examples/src/programmatic-invocation.ts`](https://github.com/routecraftjs/routecraft/blob/main/examples/src/programmatic-invocation.ts).

```ts
import { Command } from 'commander'
import { direct, craft, noop, ContextBuilder } from '@routecraft/routecraft'

// 1. Define routes with direct() sources
const capabilities = craft()
  .id('greet')
  .from(direct())
  .transform((body) => `Hello, ${(body as { name: string }).name}!`)
  .to(noop())

// 2. Build and start the context (do not await start: direct sources block until aborted)
const { context, client } = await new ContextBuilder().routes(capabilities).build()
context.start()

// 3. Dispatch into routes via client.send()
const program = new Command().name('my-tool')
program.hook('postAction', async () => {
  await context.stop()
})
program
  .command('greet')
  .argument('<name>')
  .action(async (name) => {
    const result = await client.send('greet', { name })
    console.log(result)
  })

await program.parseAsync()
```

This file is a standalone script (it owns its own context lifecycle and calls
`program.parseAsync()`), so it is run directly rather than registered with `craft run`. The
key piece is `client.send('<id>', body)`, which dispatches into a `direct()` capability and
awaits its result.

---

## Related

{% quick-links %}

{% quick-link title="Programmatic Invocation" icon="presets" href="/docs/advanced/programmatic-invocation" description="The full programmatic API and lifecycle." /%}

{% /quick-links %}
