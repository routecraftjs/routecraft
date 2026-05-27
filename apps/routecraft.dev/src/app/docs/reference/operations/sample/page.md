---
title: sample
titleBadges:
  - text: planned
    color: purple
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
sample(options: { every?: number; intervalMs?: number }): RouteBuilder<Current>
```

Take every Nth exchange or sample at time intervals. Useful for reducing data volume while maintaining representativeness.

```ts
// Take every 5th exchange
.sample({ every: 5 })

// Sample every 10 seconds (first exchange in each window)
.sample({ intervalMs: 10000 })

// Typical use: Reduce high-frequency data
.id('high-frequency-metrics')
.from(direct())
.sample({ every: 100 }) // Only process 1% of metrics
.to(database({ operation: 'save' }))
```
