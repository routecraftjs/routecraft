---
title: Hello World
---

An in-memory source dispatching to a second capability by id, with an HTTP enrichment. {% .lead %}

Two capabilities: `hello-world` emits a user id and dispatches to `greet` over `direct()`;
`greet` looks the user up over HTTP and returns a greeting. Source:
[`examples/src/hello-world.ts`](https://github.com/routecraftjs/routecraft/blob/main/examples/src/hello-world.ts).

```ts
import { log, craft, simple, http, direct } from '@routecraft/routecraft'
import { z } from 'zod'

const GreetInput = z.object({ userId: z.number() })
type GreetInput = z.infer<typeof GreetInput>

const greetRoute = craft()
  .id('greet')
  .title('Greet user')
  .description('Look up a user by id and return a greeting message')
  .input({ body: GreetInput })
  .from<GreetInput>(direct())
  .enrich(
    http<GreetInput, { name: string }>({
      method: 'GET',
      url: (ex) => `https://jsonplaceholder.typicode.com/users/${ex.body.userId}`,
    }),
  )
  .transform((result) => `Hello, ${result.body.name}!`)
  .to(log())

const helloWorldRoute = craft()
  .id('hello-world')
  .from(simple({ userId: 1 }))
  .to(direct<GreetInput>('greet'))

export default [greetRoute, helloWorldRoute]
```

This is the shape `bunx create-routecraft --example hello-world` scaffolds. It shows the three
ideas you reach for most: an in-memory trigger (`simple`), calling another capability by id
(`direct`), and merging an API response into the body (`enrich`).

---

## Related

{% quick-links %}

{% quick-link title="Composing Capabilities" icon="presets" href="/docs/advanced/composing-capabilities" description="Reuse capabilities with direct()." /%}
{% quick-link title="Operations" icon="presets" href="/docs/introduction/operations" description="The full operation set." /%}

{% /quick-links %}
