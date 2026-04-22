---
title: Creating adapters
---

Build your own source, destination, or processor adapter. {% .lead %}

When the built-in adapters do not cover a use case, you can write your own. Adapters are plain TypeScript classes that implement one of three interfaces.

## Source

A source produces data and starts the pipeline. Implement the `Source` interface:

```ts
import { type Source } from '@routecraft/routecraft'

class MyQueueAdapter implements Source<Message> {
  readonly adapterId = 'acme.adapter.my-queue'

  async subscribe(context, handler, abort) {
    while (!abort.signal.aborted) {
      const message = await queue.receive()
      await handler(message)
    }
  }
}
```

## Destination

A destination receives the final exchange. Implement the `Destination` interface:

```ts
import { type Destination } from '@routecraft/routecraft'

class MyStorageAdapter implements Destination<Record<string, unknown>, void> {
  readonly adapterId = 'acme.adapter.my-storage'

  async send(exchange) {
    await storage.write(exchange.body)
  }
}
```

If `send` returns a value, the exchange body is replaced with it. If it returns nothing, the body is unchanged.

Use a `Destination` with `.enrich()` when you need to fetch external data and merge it into the body:

```ts
class MyEnricherAdapter implements Destination<InputType, ExtraFields> {
  readonly adapterId = 'acme.adapter.my-enricher'

  async send(exchange) {
    return fetchExtra(exchange.body.id)
  }
}

// The returned value is merged into the body
.enrich(myEnricher({ apiKey: process.env.ENRICH_KEY }))
```

## Processor

A processor sits in the middle of a pipeline and modifies the exchange. Implement the `Processor` interface. Use this when you need header or context access alongside body reshaping -- for body-only changes, `.transform()` is the simpler choice:

```ts
import { type Processor } from '@routecraft/routecraft'

class MyTransformAdapter implements Processor<InputType, OutputType> {
  readonly adapterId = 'acme.adapter.my-transform'

  async process(exchange) {
    const tenantId = exchange.headers['x-tenant']
    return { ...exchange, body: { ...exchange.body, tenantId } }
  }
}
```

## Factory function

Expose your adapter as a factory function so it reads naturally in the DSL. The recommended pattern is one factory per adapter -- one name, one import:

```ts
// adapters/my-storage.ts
export function myStorage(options?: MyStorageOptions) {
  return new MyStorageAdapter(options)
}

// Usage -- destination
.to(myStorage({ bucket: 'uploads' }))
```

```ts
// adapters/my-queue.ts
export function myQueue(options?: MyQueueOptions) {
  return new MyQueueAdapter(options)
}

// Usage -- source
.from(myQueue({ queue: 'orders' }))
```

```ts
// adapters/my-enricher.ts
export function myEnricher(options?: MyEnricherOptions) {
  return new MyEnricherAdapter(options)
}

// Usage -- enricher (merges result into body)
.enrich(myEnricher({ apiKey: process.env.ENRICH_KEY }))
```

Keeping one factory per adapter makes imports predictable and avoids a proliferation of role-suffixed exports (`myQueueSource`, `myQueueDestination`, etc.). The adapter class itself handles the role -- the factory just wires up the options.

An adapter class can implement multiple interfaces when it makes sense. A queue adapter, for example, may work as both a source and a destination:

```ts
class MyQueueAdapter implements Source<Message>, Destination<Message, void> {
  readonly adapterId = 'acme.adapter.my-queue'

  async subscribe(context, handler, abort) {
    while (!abort.signal.aborted) {
      const message = await queue.receive(this.options.queue)
      await handler(message)
    }
  }

  async send(exchange) {
    await queue.send(this.options.queue, exchange.body)
  }
}

export function myQueue(options: MyQueueOptions) {
  return new MyQueueAdapter(options)
}

// Same factory, different positions
.from(myQueue({ queue: 'orders' }))
.to(myQueue({ queue: 'results' }))
```

## Making your adapter mockable

Tag every adapter instance your factory returns so consumers can mock it with `mockAdapter(yourFactory, ...)` instead of having to import the internal adapter class. Tagging is a one-line addition per return path:

```ts
import { tagAdapter, factoryArgs } from '@routecraft/routecraft'

export function myQueue(options: MyQueueOptions) {
  return tagAdapter(new MyQueueAdapter(options), myQueue, factoryArgs(options))
}
```

`tagAdapter` stamps the instance with two non-enumerable symbol properties: a reference to the factory function (so `mockAdapter(myQueue, ...)` can match instances back to their factory) and the args the user passed at the call site (so mock handlers can receive them via `meta.args` and discriminate same-factory call sites).

`factoryArgs(...)` builds the args tuple and trims trailing `undefined` so `call.args.length` reflects what the user actually typed. Use it rather than hand-building an array so your adapter behaves consistently with the framework's built-in adapters.

For a multi-interface factory, tag at every return path:

```ts
export function myQueue(
  options: MyQueueSourceOptions | MyQueueDestinationOptions,
) {
  if ('consumerGroup' in options) {
    return tagAdapter(new MyQueueSourceAdapter(options), myQueue, factoryArgs(options))
  }
  return tagAdapter(new MyQueueDestinationAdapter(options), myQueue, factoryArgs(options))
}
```

Consumers can then write a single mock that covers both roles:

```ts
const queueMock = mockAdapter(myQueue, {
  source: [{ id: 1 }, { id: 2 }],
  send: async (exchange, { args }) => {
    // args[0] is whatever the user passed to myQueue() at this call site,
    // so you can assert on it or branch behaviour per call site.
    return { ok: true }
  },
})
```

Tagging is optional. Consumers of an untagged adapter can still mock it by class: `mockAdapter(MyQueueAdapter, ...)`. But tagging is the better DX, especially for factories that fan out into multiple concrete classes based on their arguments, so it's the recommended default for every published adapter.

See the [testing guide](/docs/introduction/testing#mocking-external-adapters) for the consumer-side API.

## Supporting merged options

If your adapter has options that users might want to set once for the entire context (connection strings, timeouts, credentials), implement `MergedOptions<T>`. This lets users register defaults via a plugin while still allowing per-adapter overrides.

```ts
import { type MergedOptions, type CraftContext } from '@routecraft/routecraft'

const MY_OPTIONS = Symbol.for('acme.adapter.my-adapter.options')

declare module '@routecraft/routecraft' {
  interface StoreRegistry {
    [MY_OPTIONS]: Partial<MyOptions>
  }
}

class MyAdapter implements Destination<unknown, void>, MergedOptions<MyOptions> {
  readonly adapterId = 'acme.adapter.my-adapter'
  public options: Partial<MyOptions>

  constructor(options?: Partial<MyOptions>) {
    this.options = options ?? {}
  }

  mergedOptions(context: CraftContext): MyOptions {
    const store = context.getStore(MY_OPTIONS) as Partial<MyOptions> | undefined
    return { ...store, ...this.options }
  }

  async send(exchange) {
    const opts = this.mergedOptions(exchange.context)
    // ...
  }
}
```

Then ship a companion plugin so users have a typed, discoverable API:

```ts
export function myAdapterPlugin(defaults: Partial<MyOptions>): CraftPlugin {
  return {
    apply(ctx) { ctx.setStore(MY_OPTIONS, defaults) },
  }
}
```

See the [Merged Options guide](/docs/advanced/merged-options) for the full walkthrough and design rationale.

## Sharing state between adapters

Adapters can use the context store to share state, read global configuration set by plugins, or maintain connections across exchanges. See [Plugins](/docs/advanced/plugins) for how to populate the context store at startup.

---

## Related

{% quick-links %}

{% quick-link title="Adapters" icon="presets" href="/docs/introduction/adapters" description="How adapters work and how to configure them." /%}
{% quick-link title="Adapters reference" icon="presets" href="/docs/reference/adapters" description="Full catalog with all options and signatures." /%}

{% /quick-links %}
