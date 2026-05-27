---
title: throttle
titleBadges:
  - text: planned
    color: purple
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
throttle(options: { requestsPerSecond: number } | { requestsPerMinute: number }): RouteBuilder<Current>
```

Rate limit the next operation to prevent overwhelming downstream systems.

```ts
craft()
  .id('rate-limited-api')
  .from(source)
  .throttle({ requestsPerSecond: 10 })
  .process(apiCall) // API calls will be throttled to 10/second
  .to(destination)
```
