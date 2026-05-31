---
title: Split and aggregate
---

Fan a collection out into per-item processing, then fan back in. {% .lead %}

`process-order` splits an order into items, sends each to the `price-check` capability for
validation and pricing, then aggregates the results. `price-check` shows per-item rejection
with `.filter()` and schema validation. Source:
[`examples/src/split.ts`](https://github.com/routecraftjs/routecraft/blob/main/examples/src/split.ts).

```ts
import { log, craft, simple, direct, noop } from '@routecraft/routecraft'
import { z } from 'zod'

const OrderItemSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPrice: z.number().positive(),
})
type OrderItem = z.infer<typeof OrderItemSchema>

const priceCheck = craft()
  .id('price-check')
  .input({ body: OrderItemSchema })
  .from<OrderItem>(direct())
  .filter((ex) => (ex.body.quantity > 100 ? { reason: 'quantity exceeds limit' } : true))
  .transform((item) => ({
    ...item,
    total: Math.round(item.unitPrice * item.quantity * (item.quantity >= 10 ? 0.9 : 1) * 100) / 100,
  }))
  .to(noop())

const processOrder = craft()
  .id('process-order')
  .from(simple({ orderId: 'ORD-2026-001', items: [/* ... */] }))
  .transform((order) => order.items)
  .split()
  .schema(OrderItemSchema)
  .to(direct<OrderItem>('price-check'))
  .aggregate()
  .to(log())

export default [priceCheck, processOrder]
```

`.split()` turns a collection body into one exchange per item; `.schema()` validates each
item; `.to(direct(...))` hands each to the per-item capability; `.aggregate()` fans the
results back into a single body. Items that fail `.filter()` are dropped with a reason.

---

## Related

{% quick-links %}

{% quick-link title="Operations" icon="presets" href="/docs/reference/operations" description="split, aggregate, filter, schema and the rest." /%}

{% /quick-links %}
