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

When a body schema is given, the chain is retyped: the following `.from(source)` opens the pipeline with the schema's inferred output type, so the body type does not have to be repeated as a `.from<T>()` generic. An explicit `.from<T>(source)` still overrides the inferred type.

```ts
craft()
  .id('ingest')
  .input({ body: OrderSchema, headers: AuthHeaders })
  .from(direct())
  // body is already typed as the OrderSchema output
  .to(saveOrder)

// Body-only shorthand
craft()
  .id('ingest')
  .input(OrderSchema)
  .from(direct())
  .to(saveOrder)
```
