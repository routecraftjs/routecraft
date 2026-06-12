---
title: input
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
input(
  schema: StandardSchemaV1 | { body?: StandardSchemaV1; headers?: StandardSchemaV1 },
): RouteBuilder<Current>
```

Declare input validation for the next route. The engine validates the incoming body and headers against these schemas **before any pipeline step runs**; a validation failure emits `exchange:dropped` and the pipeline never sees the message. Accepts either a bundle (`{ body, headers }`) or a bare Standard Schema as a body-only shorthand.

A body schema also retypes the chain: its inferred output flows into an untyped source, so `.from(direct())` after `.input({ body })` is already narrowed without repeating the type as `.from<T>()`. A typed source (such as `mcp()`) or an explicit `.from<T>()` generic still wins.

```ts
craft()
  .id('ingest')
  .input({ body: OrderSchema, headers: AuthHeaders })
  .from(direct())
  .to(saveOrder)

// Body-only shorthand
craft()
  .id('ingest')
  .input(OrderSchema)
  .from(direct())
  .to(saveOrder)
```
