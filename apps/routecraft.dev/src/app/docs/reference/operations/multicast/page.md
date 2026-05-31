---
title: multicast
titleBadges:
  - text: planned
    color: purple
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
multicast(destinations: Array<RouteBuilder<any>>): RouteBuilder<Current>
```

Send the same exchange to multiple destinations simultaneously. Each destination receives a copy of the exchange.

```ts
.multicast([
  craft().to(database),
  craft().to(auditLog),
  craft().transform(formatForAnalytics).to(analyticsService)
])
```
