---
title: validate
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
validate<R = Current>(validator: Validator<Current, R> | CallableValidator<Current, R>): RouteBuilder<R>
```

Validate the exchange body using a Validator adapter or callable function. On success the (possibly coerced) return value replaces the body. On failure the adapter throws and the route error handler (if configured) or the default error path handles it.

For Standard Schema validation, use the `.schema()` sugar or pass the `schema()` factory.

```ts
// Custom validator
.validate((exchange) => {
  if (!exchange.body.email) throw new Error("email required");
  return exchange.body;
})

// Standard Schema via factory
import { schema } from '@routecraft/routecraft'
.validate(schema(z.object({ name: z.string() })))
```
