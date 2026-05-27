---
title: output
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
output(
  schema: StandardSchemaV1 | { body?: StandardSchemaV1; headers?: StandardSchemaV1 },
): RouteBuilder<Current>
```

Declare output validation for the next route. The engine validates the final exchange against these schemas **before the primary destination fires**; a validation failure is routed to the route's error handler (or emits `exchange:failed` when no handler is set). Accepts a bundle (`{ body, headers }`) or a bare Standard Schema as a body-only shorthand.

```ts
craft()
  .id('ingest')
  .input(OrderSchema)
  .output(SavedOrderSchema)
  .from(direct())
  .to(saveOrder)
```
