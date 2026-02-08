---
title: FAQ
---

Answers to common questions. {% .lead %}

## What is RouteCraft?

RouteCraft is a developer-first automation and integration framework that lets you build data processing pipelines using a fluent DSL.

## How do I run examples?

```bash
pnpm craft run ./examples/hello-world.mjs
```

## What's the difference between a route and a context?

A **route** is a single data processing pipeline with a source, steps, and destinations. A **context** is the runtime environment that manages multiple routes, handles their lifecycle, and provides shared services like logging and storage.

## Can routes communicate with each other?

Yes! Use the `direct()` adapter to send data between routes:

```ts
// Producer route
craft()
  .id('producer')
  .from(source)
  .to(direct('my-channel'))

// Consumer route  
craft()
  .id('consumer')
  .from(direct('my-channel', {}))
  .to(destination)
```

## How do I handle errors in routes?

RouteCraft provides several error handling approaches:

- **Route isolation**: Failed routes don't affect other routes
- **Event monitoring**: Subscribe to `error` events for centralized error handling
- **Validation**: Use `.validate(schema)` to catch data issues early
- **Try/catch**: Use `.process()` with custom error handling logic

## What adapters are available?

RouteCraft includes many built-in adapters like `simple()`, `timer()`, `csv()`, `http()`, `fetch()`, and more.

For the complete list with examples and options, see [Adapters Reference](/docs/reference/adapters).

## How do I create custom adapters?

Implement the appropriate interface (`Source`, `Processor`, or `Destination`) and provide an `adapterId`:

```ts
class MyAdapter implements Source<string> {
  readonly adapterId = 'my.custom.adapter'
  
  async subscribe(context, handler, controller) {
    // Your implementation
  }
}
```

## When should I use direct adapter validation vs `.validate()` operation?

**Use direct adapter validation when:**
- Defining consumer contracts (what the endpoint accepts)
- Building discoverable routes (schema is metadata)
- Validating at route boundaries (inter-route communication)
- Protecting the route itself from invalid input

**Use `.validate()` operation when:**
- Protecting downstream systems from invalid data
- Validating before sending to external destinations
- Multiple validation steps at different stages
- Filtering invalid messages mid-pipeline

**The key distinction:**

| | Protects | Use case |
|---|----------|-----------|
| `schema` on adapter | The consumer route itself | "I only accept valid data" |
| `.validate()` | Downstream destinations | "Only send valid data out" |

**Example:**

```ts
import { z } from 'zod'

const OrderSchema = z.object({
  orderId: z.string(),
  items: z.array(z.object({ productId: z.string(), quantity: z.number() }))
})

const PaymentSchema = z.object({
  method: z.enum(['card', 'bank']),
  amount: z.number().positive()
})

// Direct adapter: protect this route from bad input
craft()
  .from(direct('orders', {
    schema: OrderSchema  // Reject invalid orders at entry
  }))
  .transform(order => calculatePayment(order))
  .validate(PaymentSchema)  // Protect payment gateway from bad data
  .to(paymentGateway)
```

Direct adapter validation is about **self-protection** (contract enforcement), while `.validate()` is about **protecting downstream systems** before sending data out.
