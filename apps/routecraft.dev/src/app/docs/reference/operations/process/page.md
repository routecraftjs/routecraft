---
title: process
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
process<Next = Current>(fn: Processor<Current, Next> | CallableProcessor<Current, Next>): RouteBuilder<Next>
```

Process the exchange with full access to headers, body, and context. Use when you need more control than `transform`.

```ts
.process((exchange) => {
  const userId = exchange.headers.get('user-id')
  return {
    ...exchange.body,
    processedBy: userId,
    timestamp: new Date().toISOString()
  }
})
```
