---
title: from
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
from<T>(src: Source<T> | CallableSource<T>): RouteBuilder<T>
```

Defines the source adapter and creates the capability. Must come after all other route-level operations (`id`, `batch`, `error`).

**Returns:** `RouteBuilder<T>` where `T` is the body type produced by the source.

```ts
.id('timer-route')
.from(timer({ intervalMs: 1000 }))

// Callable source (async function)
.id('data-fetcher')
.from(async () => await fetchData())
```
