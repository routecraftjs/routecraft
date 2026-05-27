---
title: tag
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
tag(value: Tag | Tag[]): RouteBuilder<Current>
```

Tag the next route. Accepts a single tag or an array; multiple `.tag()` calls before `from()` accumulate (deduplicated, insertion order preserved). Empty strings are rejected with `RC2001`.

Tags drive selectors like `tools({ tagged: "read-only" })` in `@routecraft/ai`. The `KnownTag` literals `"read-only"`, `"destructive"`, and `"idempotent"` autocomplete; any other string is also accepted.

```ts
craft()
  .id('list-orders')
  .tag('read-only')
  .from(direct())
  .to(listOrders)

// Multiple tags
craft()
  .id('delete-order')
  .tag(['destructive', 'orders'])
  .from(direct())
  .to(deleteOrder)
```
