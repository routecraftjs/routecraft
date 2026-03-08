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
  readonly adapterId = 'my.queue'

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
  readonly adapterId = 'my.storage'

  async send(exchange) {
    await storage.write(exchange.body)
  }
}
```

If `send` returns a value, the exchange body is replaced with it. If it returns nothing, the body is unchanged.

## Processor

A processor sits in the middle of a pipeline and modifies the exchange. Implement the `Processor` interface:

```ts
import { type Processor } from '@routecraft/routecraft'

class MyTransformAdapter implements Processor<InputType, OutputType> {
  readonly adapterId = 'my.transform'

  async process(exchange) {
    const extra = await fetchExtra(exchange.body.id)
    return { ...exchange, body: { ...exchange.body, ...extra } }
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
  return new MyTransformAdapter(options)
}

// Usage -- processor
.process(myEnricher({ apiKey: process.env.ENRICH_KEY }))
```

Keeping one factory per adapter makes imports predictable and avoids a proliferation of role-suffixed exports (`myQueueSource`, `myQueueDestination`, etc.). The adapter class itself handles the role -- the factory just wires up the options.

An adapter class can implement multiple interfaces when it makes sense. A queue adapter, for example, may work as both a source and a destination:

```ts
class MyQueueAdapter implements Source<Message>, Destination<Message, void> {
  readonly adapterId = 'my.queue'

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

## Sharing state between adapters

Adapters can use the context store to share state, read global configuration set by plugins, or maintain connections across exchanges.

```ts
class DbAdapter implements Destination<any, void> {
  async send(exchange) {
    const config = exchange.context.getStore('db.config')
    await db(config.connectionString).insert(exchange.body)
  }
}
```

See [Plugins](/docs/introduction/plugins) for how to populate the context store at startup.

---

## Related

{% quick-links %}

{% quick-link title="Adapters" icon="presets" href="/docs/introduction/adapters" description="How adapters work and how to configure them." /%}
{% quick-link title="Adapters reference" icon="presets" href="/docs/reference/adapters" description="Full catalog with all options and signatures." /%}

{% /quick-links %}
