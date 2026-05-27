---
title: noop
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
noop<T>(): NoopAdapter<T>
```

A no-operation adapter that discards messages. Useful for testing, development, or conditional routing.

```ts
// Conditional destination based on environment
.to(process.env.NODE_ENV === 'production' ? realDestination() : noop())

// Testing placeholder
.to(noop()) // Messages are discarded but logged
```
