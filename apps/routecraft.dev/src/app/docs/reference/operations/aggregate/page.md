---
title: aggregate
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
aggregate<R>(fn?: Aggregator<Current, R> | CallableAggregator<Current, R>): RouteBuilder<R>
```

Combine multiple exchanges into a single result. Useful after `split` to recombine processed items.

If no aggregator is provided, exchange bodies are automatically collected into an array. **If any body is an array, all arrays are flattened and combined with scalar values into a single flattened array.**

```ts
// Automatically collect bodies into an array
.split()
.process((exchange) => ({ ...exchange, body: exchange.body * 2 }))
.aggregate() // Returns array of processed items: [2, 4, 6]

// Arrays are automatically flattened
// Input: [1, [2, 3], 4, [5, 6]]
// Output: [1, 2, 3, 4, 5, 6] (flattened)

// Mixed arrays and scalars are combined
// Input: [[1, 2], 3, [4, 5]]
// Output: [1, 2, 3, 4, 5] (arrays flattened, scalars added)

// Custom aggregation logic
.aggregate((items) => ({
  totalCount: items.length,
  processedAt: new Date().toISOString(),
  items
}))
```
