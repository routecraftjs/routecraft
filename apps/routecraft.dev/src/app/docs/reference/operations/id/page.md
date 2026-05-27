---
title: id
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
id(routeId: string): RouteBuilder<Current>
```

Set the unique identifier for the next route. Place before `from()`. If called after a route already exists, it is staged and applies to the next `from()` (it does not rename the current route).

```ts
craft()
  .id('data-processor')
  .from(source)
  .to(destination)

// If called after an existing route, id() is staged for the next route
// (does not change the current route)
craft()
  .from(source)
  .id('next-route-id')
  .from(otherSource)
  .to(destination)
```

If no ID is specified, a random UUID will be generated automatically.
