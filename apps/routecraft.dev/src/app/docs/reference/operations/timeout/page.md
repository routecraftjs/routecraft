---
title: timeout
titleBadges:
  - text: planned
    color: purple
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
timeout(timeoutMs: number): RouteBuilder<Current>
```

Wrap the next operation with a timeout. If the operation does not complete within the specified duration, it will be cancelled and a `TimeoutError` will be thrown.

```ts
craft()
  .id('timeout-protected')
  .from(source)
  .timeout(5000)
  .process(slowOperation) // Throws TimeoutError if slowOperation exceeds 5 seconds
  .to(destination)
```

See [chaining wrappers](#chaining-wrappers) for combining with `retry` or `onError`.
