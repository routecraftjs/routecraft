---
title: tag
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
tag(value: Tag | Tag[]): RouteBuilder<Current>
```

Tag the next route. Accepts a single tag or an array; multiple `.tag()` calls before `from()` accumulate (deduplicated, insertion order preserved). Empty strings are rejected with `RC2001`.

Tags surface on the `ToolsCatalog` snapshot handed to the builder form of `tools()` in `@routecraft/ai`, so an agent can filter its tool surface programmatically:

```ts
tools((catalog) =>
  catalog.routes
    .filter((r) => r.tags?.includes('read-only'))
    .map((r) => `Direct(${r.id})`),
)
```

The `KnownTag` literals `"read-only"`, `"destructive"`, `"idempotent"`, and `"open-world"` autocomplete; any other string is also accepted. On a route exposed via `from(mcp())`, these four tags also derive the corresponding MCP tool annotation hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).

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
