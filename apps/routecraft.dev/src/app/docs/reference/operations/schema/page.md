---
title: schema
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
schema<S extends StandardSchemaV1>(standardSchema: S): RouteBuilder<StandardSchemaV1.InferOutput<S>>
```

Validate the exchange body against a Standard Schema. Sugar for `.validate(schema(standardSchema))`. On failure throws RC5002 with formatted issue details. The route builder type is narrowed to the schema's output type.

```ts
import { z } from 'zod'

const userSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  age: z.number().min(0)
})

.schema(userSchema)
// Validation failures throw RC5002: "Validation failed: "email": Invalid email; "age": Number must be greater than or equal to 0"
```
