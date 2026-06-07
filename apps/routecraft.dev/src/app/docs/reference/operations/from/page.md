---
title: from
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
from<T>(src: Source<T> | CallableSource<T>): RouteBuilder<T>
from<T>(
  source1: Source<unknown> | CallableSource<unknown>,
  source2: Source<unknown> | CallableSource<unknown>,
  ...moreSources: Array<Source<unknown> | CallableSource<unknown>>
): RouteBuilder<T>
```

Defines the source adapter(s) and creates the capability. Must come after all other route-level operations (`id`, `batch`, `error`).

**Returns:** `RouteBuilder<T>` where `T` is the body type produced by the source.

```ts
.id('timer-route')
.from(timer({ intervalMs: 1000 }))

// Callable source (async function)
.id('data-fetcher')
.from(async () => await fetchData())
```

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
