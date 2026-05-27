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

To flow the validated body type through the chain, pass it as a generic on `.from<T>(source)` after the `.input()` call.

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
