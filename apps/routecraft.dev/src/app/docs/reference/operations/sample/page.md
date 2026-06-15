---
title: sample
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
sample(options: { every: number } | { intervalMs: number }): RouteBuilder<Current>
```

Reduce data volume from a high-frequency source by passing a representative subset of exchanges and dropping the rest. A dropped exchange is discarded silently, exactly like a `filter` predicate returning `false`.

Pass exactly one of `every` or `intervalMs`; they are mutually exclusive (a sampler is either count-based or time-based). Sampler state (the counter or the window timestamp) is per-route.

```ts
// Count-based: take every 5th exchange
.sample({ every: 5 })

// Time-based: pass the first exchange in each 10-second window
.sample({ intervalMs: 10000 })

// Typical use: reduce high-frequency data
craft()
  .id('high-frequency-metrics')
  .from(direct())
  .sample({ every: 100 }) // Process roughly 1% of metrics
  .to(database({ operation: 'save' }))
```

**Options:**
- `every` - Count-based: pass every Nth exchange. An internal counter increments on each exchange; when it reaches `every` the exchange passes and the counter resets to zero, so `{ every: 5 }` passes the 5th, 10th, 15th, ... exchange. Must be a finite integer >= 1.
- `intervalMs` - Time-based: pass the first exchange seen in each window of `intervalMs` milliseconds and drop the rest until the window elapses. Must be a finite number > 0.

**Events:**
- `route:operation:sample:passed` - emitted for each admitted exchange, with `mode` (`"count"` or `"interval"`).
- `route:operation:sample:dropped` - emitted for each dropped exchange. A `route:exchange:dropped` event (reason `"sampled"`) also fires so telemetry and the TUI count it.

{% callout type="note" title="sample vs filter vs throttle" %}
`filter` keeps or drops each exchange independently by a predicate. `sample` drops by position (count) or time, keeping a representative subset. `throttle` enforces a rate without sampling: by default (`mode: "delay"`) it paces over-limit exchanges, and in `mode: "reject"` it fails them fast rather than dropping them. Reach for `sample` to thin a firehose, `throttle` to smooth one.
{% /callout %}
