---
title: batch
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
batch(options?: { size?: number; flushIntervalMs?: number }): RouteBuilder<Current>
```

Process exchanges in batches instead of one at a time. Useful for bulk operations like database inserts or API batch requests.

```ts
craft()
  .id('bulk-processor')
  .batch({ size: 50, flushIntervalMs: 5000 })
  .from(timer({ intervalMs: 1000 }))
  .to(saveToDB)
```

**Options:**
- `size` - Maximum exchanges per batch (default: 100)
- `flushIntervalMs` - Maximum wait time in milliseconds before flushing a partial batch (default: 5000ms)

{% callout type="note" title="Linting: route-level positioning" %}
Use the ESLint rule `@routecraft/routecraft/batch-before-from` to ensure `batch()` is placed **before** `.from()`. See [Linting Rules](/docs/reference/linting#batch-before-from).
{% /callout %}

{% callout type="warning" title="Incompatible with synchronous sources" %}
The `batch()` operation only works with asynchronous message sources like `timer()`. It **cannot** be used with `direct()` sources because direct endpoints are synchronous and blocking -- each sender waits for the consumer to fully process a message before the next can be sent, preventing message accumulation.

If you need to combine multiple messages from split branches, use the `aggregate()` operation instead.
{% /callout %}
