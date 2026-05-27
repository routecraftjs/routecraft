---
title: delay
titleBadges:
  - text: planned
    color: purple
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
delay(delayMs: number): RouteBuilder<Current>
```

Add a fixed delay before executing the next operation. Useful for rate limiting or adding processing delays.

```ts
craft()
  .id('delayed-processor')
  .from(source)
  .delay(1000)
  .process(operation) // Operation will execute after 1 second delay
  .to(destination)
```
