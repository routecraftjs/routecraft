# Adapters

Connectors that link your capabilities to the outside world.

## What are adapters?

Adapters are the boundary between Routecraft and external systems. They handle the integration details -- making HTTP calls, reading files, triggering on a schedule -- so your capabilities stay focused on business logic.

Every capability starts with a source adapter in `.from()` and ends with a destination adapter in `.to()`. Operations in the middle can also use adapters to enrich data or observe side effects.

## The adapter roles

### Source

A source produces data and starts the flow. It goes in `.from()`.

```ts
// Triggered by a timer
.from(timer({ intervalMs: 60_000 }))

// One-shot with a fixed payload
.from(simple({ report: 'daily-summary' }))

// Receives messages from another capability (endpoint = route id)
.from(direct())
```

### Destination

A destination pushes the exchange out to an external system. It goes in `.to()`. The push is void: the body flows through unchanged, and a receipt (a message id, an etag) lands on headers.

```ts
.to(log())
.to(json({ path: './output.json' }))
.to(jsonl({ path: './events.jsonl', append: true }))
.to(mail())
```

### Enricher

An enricher pulls a value in per exchange -- an HTTP GET, a file read, a lookup on another capability. It goes in `.enrich()`, where the fetched value replaces the body (or feeds an aggregator such as `only()` to merge). `.to()` accepts an enricher too: the result replaces the body there as well.

```ts
.enrich(http({ url: 'https://api.example.com/users/1' }))
.to(http({ method: 'POST', url: 'https://api.example.com/events' }))
.to(direct('next-stage'))
```

### Processor

A processor sits in the middle of a pipeline and modifies the exchange. It goes in `.process()`.

```ts
.process(myCustomProcessor)
```

Any destination or enricher can also be passed to `.tap()`. The `.tap()` operation is what makes it fire-and-forget -- results and receipts are discarded, the adapter itself is unchanged.

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

### Merged options and craft config

Many adapters support **merged options**: they merge their own per-call options with context-level defaults set in `craft.config.ts`. This means you can define shared settings once and every adapter of that type picks them up automatically.

```ts
// craft.config.ts
import type { CraftConfig } from '@routecraft/routecraft'

const config: CraftConfig = {
  cron: { timezone: 'UTC', jitterMs: 2000 },
}

export default config
```

```ts
// capability file -- timezone and jitterMs come from the config
.from(cron('@daily'))

// Override timezone for this specific source
.from(cron('0 9 * * 1-5', { timezone: 'America/New_York' }))
```

Options passed directly to the adapter always take precedence over config defaults. See the [Merged Options guide](/docs/advanced/merged-options) for the full pattern and a list of adapters that support it.

---

## Related

- [Adapters reference](/docs/reference/adapters) -- Full catalog with all options and signatures.
- [Creating adapters](/docs/advanced/custom-adapters) -- Build your own source, destination, enricher, or processor adapter.
