---
title: from
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
from<T>(src: SourceLike<T>): RouteBuilder<T>
from<T>(
  source1: SourceLike<unknown>,
  source2: SourceLike<unknown>,
  ...moreSources: Array<SourceLike<unknown>>
): RouteBuilder<T>

// SourceLike<T> = Source<T> | CallableSource<T> | GeneratorSource<T>
//               | AsyncIterable<T> | Iterable<T>
```

Defines the source adapter(s) and creates the capability. Must come after all other route-level operations (`id`, `batch`, `error`).

**Returns:** `RouteBuilder<T>` where `T` is the body type produced by the source.

When the route declares `.input()` with a body schema before `.from()`, `T` defaults to the schema's inferred output type and the generic can be omitted; see [input](/docs/reference/operations/input). An explicit `.from<T>()` still overrides it.

```ts
.id('timer-route')
.from(timer({ intervalMs: 1000 }))

// Generator source: each yield becomes one exchange
.id('data-fetcher')
.from(async function* () {
  yield await fetchData()
})

// Callable source: full control via the Subscription object
.id('poller')
.from(async (sub) => {
  while (!sub.signal.aborted) {
    await sub.emit({ message: await poll() })
  }
})
```

Inline sources receive a single `Subscription` object: `{ context, signal, meta, ready(), complete(reason?), emit(msg) }`. Generator functions get the same object as their argument and may simply `yield` bodies; iteration applies natural backpressure (one `emit` awaited per yield) and the source completes when the generator returns.

## Multiple ingresses

A capability often needs to be reachable on more than one channel: `direct` for internal callers, `mcp` for agents, `http` for integrations. Pass several sources to a single `.from()` and they all feed the same pipeline. The capability stays one route: one id, one lifecycle event stream, and one public name on the registries that derive it from the route id (`direct` endpoint, `mcp` tool name).

```ts
craft()
  .id('servicenow-fetch')
  .description('Fetch an incident by number.')
  .input(ServiceNowInputSchema)
  .tag('read-only') // also derives the mcp readOnlyHint
  .from(
    direct(), // internal callers
    mcp(), // agents
    http({ path: '/servicenow/fetch', method: 'POST' }), // integrations
  )
  .transform((body) => incidents.find((i) => i.number === body.incidentId))
  .log()
```

Rules:

- **`.input()` is required** with multiple sources. Each ingress emits a different raw body type (`direct` is `unknown`, `mcp` is the tool argument, `http` is the request body); the input schema validates and normalizes all of them to one shared type before the pipeline runs. Without it the pipeline body would be an unsound union, so the build fails with `RC2001`.
- **Authorization applies uniformly.** A route-level `.authorize()` runs for every ingress. When channels need *different* auth (for example, an unauthenticated internal `direct` ingress next to a scoped `mcp` one), express each channel as its own single-source route instead.
- **`.batch()` works per ingress.** Each source gets its own batch window, so a batch never merges items arriving on different channels.

When a channel genuinely needs a different contract, keep it as a separate route that delegates to the canonical one via `to(direct('...'))`.
