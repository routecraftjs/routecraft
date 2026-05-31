---
title: debug
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
debug(
  formatter?: (exchange: Exchange<Current>) => unknown,
  options?: Record<string, never>,
): RouteBuilder<Current>
```

Sugar for `.tap(debug(formatter))`. Same shape as `.log()`, but the level is fixed to `debug`. Useful for verbose pipeline tracing that can be silenced via the logger configuration without removing the call.

```ts
// Debug log id, body, headers
.debug()

// Debug log a derived value
.debug((exchange) => ({ correlation: exchange.headers['x-correlation-id'], body: exchange.body }))
```
