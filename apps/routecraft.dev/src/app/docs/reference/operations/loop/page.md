---
title: loop
titleBadges:
  - text: planned
    color: purple
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
loop(condition: (body: Current, iteration: number) => boolean, maxIterations?: number): RouteBuilder<Current>
```

Repeat the subsequent operations while the condition remains true. Includes safeguards to prevent infinite loops.

```ts
.loop(
  (data, iteration) => data.hasMore && iteration < 10,
  10 // max iterations safeguard
)
.transform(processPage)
.process(fetchNextPage)
```
