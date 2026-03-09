---
title: Composing Capabilities
---

Connect capabilities together to build multi-stage pipelines. {% .lead %}

The `direct()` adapter is an in-process channel that lets one capability hand off data to another. Each capability stays focused on a single concern; `direct()` connects them without coupling the files.

## Linear chain

The simplest pattern: one capability fetches data, passes it to a processor, which passes it to a notifier.

```ts
// capabilities/fetch-orders.ts
export default craft()
  .id('orders.fetch')
  .from(timer({ intervalMs: 300_000 }))
  .transform(fetchNewOrders)
  .to(direct('orders.process'))
```

```ts
// capabilities/process-orders.ts
export default craft()
  .id('orders.process')
  .from(direct('orders.process', {}))
  .transform(fulfillOrder)
  .to(direct('orders.notify'))
```

```ts
// capabilities/notify-orders.ts
export default craft()
  .id('orders.notify')
  .from(direct('orders.notify', {}))
  .to(http({ method: 'POST', path: '/notifications' }))
```

The channel name is just a string -- use a namespaced convention (e.g. `domain.stage`) to keep them readable as the project grows.

## Fan-out

To send to multiple downstream capabilities, use `.tap()` for all but the primary output. `.tap()` is fire-and-forget and does not alter the exchange.

```ts
// capabilities/ingest-event.ts
export default craft()
  .id('events.ingest')
  .from(http({ path: '/events', method: 'POST' }))
  .tap(direct('events.audit'))
  .tap(direct('events.metrics'))
  .to(direct('events.process'))
```

```ts
// capabilities/audit-event.ts
export default craft()
  .id('events.audit')
  .from(direct('events.audit', {}))
  .to(json({ path: './logs/audit.jsonl' }))
```

```ts
// capabilities/metrics-event.ts
export default craft()
  .id('events.metrics')
  .from(direct('events.metrics', {}))
  .transform(({ type }) => ({ counter: type }))
  .to(http({ method: 'POST', path: '/metrics' }))
```

## Dynamic routing

The destination channel can be resolved at runtime from the exchange body or headers. This lets a single capability route to different consumers without knowing them all in advance.

```ts
// capabilities/route-by-priority.ts
export default craft()
  .id('jobs.route')
  .from(http({ path: '/jobs', method: 'POST' }))
  .to(direct((exchange) => `jobs.${exchange.body.priority}`))
```

```ts
// capabilities/high-priority.ts
export default craft()
  .id('jobs.high')
  .from(direct('jobs.high', {}))
  .transform(processUrgent)
  .to(log())
```

```ts
// capabilities/normal-priority.ts
export default craft()
  .id('jobs.normal')
  .from(direct('jobs.normal', {}))
  .transform(processNormal)
  .to(log())
```

## Schema validation on receive

The source side of `direct()` accepts a `schema` option. RouteCraft validates the incoming body before the capability runs and throws `RC5002` if validation fails.

```ts
import { z } from 'zod'

export default craft()
  .id('orders.process')
  .from(direct('orders.process', {
    schema: z.object({
      orderId: z.string(),
      items: z.array(z.string()),
    }),
  }))
  .transform(fulfillOrder)
  .to(log())
```

## How direct() knows its role

`direct()` is overloaded -- the number of arguments determines whether it acts as a source or destination:

- **`direct('channel', options)`** -- two arguments, acts as a **source** (`.from()`)
- **`direct('channel')`** -- one argument, acts as a **destination** (`.to()`, `.tap()`)

One channel name, one import, two roles.

---

## Related

{% quick-links %}

{% quick-link title="Capabilities" icon="plugins" href="/docs/introduction/capabilities" description="Author small, focused capabilities using the DSL." /%}
{% quick-link title="Adapters reference" icon="presets" href="/docs/reference/adapters" description="Full catalog with all options and signatures." /%}

{% /quick-links %}
