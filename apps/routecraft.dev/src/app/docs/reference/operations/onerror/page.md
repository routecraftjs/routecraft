---
title: onError
titleBadges:
  - text: planned
    color: purple
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
onError(handler: (error: Error, exchange: Exchange<Current>) => Exchange<Current> | void): RouteBuilder<Current>
```

Handle errors from the next operation. If the next operation fails, the error handler is invoked.

```ts
craft()
  .id('error-resilient')
  .from(source)
  .onError((error, exchange) => {
    logger.warn('Operation failed, using fallback', { error })
    return { ...exchange, body: { fallback: true } }
  })
  .transform(riskyOperation) // Errors from this transform will be handled
  .to(destination)
```
