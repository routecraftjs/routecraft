---
title: Adapters
---

Connectors that link your capabilities to the outside world. {% .lead %}

## What are adapters?

Adapters are the boundary between RouteCraft and external systems. They handle the integration details -- making HTTP calls, reading files, triggering on a schedule -- so your capabilities stay focused on business logic.

Every capability starts with a source adapter in `.from()` and ends with a destination adapter in `.to()`. Operations in the middle can also use adapters to enrich data or observe side effects.

## The three adapter roles

### Source

A source produces data and starts the flow. It goes in `.from()`.

```ts
// Triggered by a timer
.from(timer({ intervalMs: 60_000 }))

// One-shot with a fixed payload
.from(simple({ report: 'daily-summary' }))

// Receives messages from another capability
.from(direct('incoming-jobs', {}))
```

### Destination

A destination receives the final exchange. It goes in `.to()`.

```ts
.to(log())
.to(http({ method: 'POST', url: 'https://api.example.com/events' }))
.to(json({ path: './output.json' }))
.to(direct('next-stage'))
```

If the destination returns a value, the exchange body is replaced with it. If it returns nothing, the body is unchanged.

### Processor

A processor sits in the middle of a pipeline and modifies the exchange. It goes in `.process()`.

```ts
.process(myCustomProcessor)
```

Any `Destination` adapter can also be passed to `.tap()`. The `.tap()` operation is what makes it fire-and-forget -- the adapter itself is still just a `Destination`.

## Configuring adapters

Most adapters accept an options object. Options can be static values or functions that derive a value from the exchange at runtime.

```ts
// Static
.to(http({ method: 'POST', url: 'https://api.example.com/events' }))

// Dynamic -- derived from the exchange
.to(http({
  method: 'POST',
  url: (exchange) => `https://api.example.com/users/${exchange.body.userId}`,
  body: (exchange) => exchange.body,
}))
```

### MergedOptions and craft config

Many adapters support **MergedOptions**: they merge their own options with any matching config registered in your project's `craft.config.ts`. This means you can define shared settings once -- connection strings, base URLs, credentials -- and adapters pick them up automatically without repeating them at every call site.

```ts
// craft.config.ts
export default defineConfig({
  adapters: {
    http: {
      baseUrl: 'https://api.example.com',
      headers: { Authorization: `Bearer ${process.env.API_KEY}` },
    },
  },
})
```

```ts
// capability file -- base URL and auth header come from craft.config.ts
.to(http({ method: 'POST', path: '/events' }))
```

Options passed directly to the adapter always take precedence over config-level defaults. See the [Adapters reference](/docs/reference/adapters) for which adapters support MergedOptions.

---

## Related

{% quick-links %}

{% quick-link title="Adapters reference" icon="presets" href="/docs/reference/adapters" description="Full catalog with all options and signatures." /%}
{% quick-link title="Creating adapters" icon="plugins" href="/docs/advanced/custom-adapters" description="Build your own source, destination, or processor adapter." /%}

{% /quick-links %}
