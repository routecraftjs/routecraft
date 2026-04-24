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
  .from(direct())
  .transform(fulfillOrder)
  .to(direct('orders.notify'))
```

```ts
// capabilities/notify-orders.ts
export default craft()
  .id('orders.notify')
  .from(direct())
  .to(http({ method: 'POST', path: '/notifications' }))
```

The route's `.id()` is the direct endpoint name. Destinations reference the consumer by that id. Use a namespaced convention (e.g. `domain.stage`) to keep them readable as the project grows.

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
  .from(direct())
  .to(json({ path: './logs/audit.jsonl' }))
```

```ts
// capabilities/metrics-event.ts
export default craft()
  .id('events.metrics')
  .from(direct())
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
  .from(direct())
  .transform(processUrgent)
  .to(log())
```

```ts
// capabilities/normal-priority.ts
export default craft()
  .id('jobs.normal')
  .from(direct())
  .transform(processNormal)
  .to(log())
```

## Discovery metadata and framework validation

Title, description, and request / response schemas are route-level concerns declared on the builder. The framework validates `.input()` against every incoming message before the pipeline runs, and `.output()` against the final exchange before the primary destination fires. Any source adapter inherits this validation, and any discovery-aware adapter (`direct`, `mcp`) mirrors the same metadata into its registry so agents, docs, and observability see one consistent view.

```ts
import { z } from 'zod'

export default craft()
  .id('orders.process')
  .title('Process orders')
  .description('Validate an order payload and trigger fulfilment')
  .input({
    body: z.object({
      orderId: z.string(),
      items: z.array(z.string()),
    }),
  })
  .output({ body: z.object({ ok: z.literal(true) }) })
  .from(direct())
  .transform(fulfillOrder)
  .to(log())
```

Swap `direct()` for `mcp()` (or, in the future, `agent()`) without moving any metadata; the shared fields stay on the route.

## Agent-only capabilities

Omit `.id()` to make a capability discoverable by agents but unreferenceable from code. The route still registers in the direct registry (agents can find it by description and schemas), but its endpoint is a random UUID that cannot be typed into `direct('...')` on the destination side.

```ts
export default craft()
  .title('Knowledge base lookup')
  .description('Retrieve internal documentation snippets by query')
  .input({ body: z.object({ query: z.string() }) })
  .from(direct())
  .transform(fetchSnippets)
```

## How direct() knows its role

`direct()` is overloaded -- the type of the first argument determines whether it acts as a source or destination:

- **`direct()` or `direct(options)`** -- no endpoint string (or options object), acts as a **source** (`.from()`); the route's `.id()` is the endpoint name
- **`direct('channel')` or `direct((ex) => channel)`** -- a string or function naming a target route, acts as a **destination** (`.to()`, `.tap()`)

One import, two roles, one source of truth for the endpoint name (the route id).

---

## Related

{% quick-links %}

{% quick-link title="Capabilities" icon="plugins" href="/docs/introduction/capabilities" description="Author small, focused capabilities using the DSL." /%}
{% quick-link title="Adapters reference" icon="presets" href="/docs/reference/adapters" description="Full catalog with all options and signatures." /%}

{% /quick-links %}
