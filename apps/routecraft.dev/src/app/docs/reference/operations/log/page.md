---
title: log
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
log(
  formatter?: (exchange: Exchange<Current>) => unknown,
  options?: { level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' },
): RouteBuilder<Current>
```

Sugar for `.tap(log(formatter, options))`. Logs the current exchange via the exchange logger and continues the pipeline unchanged. Defaults to `info` level. By default the logger prints `id`, `body`, and `headers`; pass a `formatter` to log a derived value instead.

```ts
// Log id, body, headers at info level
.log()

// Log a derived value
.log((exchange) => ({ id: exchange.id, body: exchange.body }))

// Log at a different level
.log(undefined, { level: 'warn' })
```

Use `.log()` for ad-hoc visibility inside a route. For more control or a non-default destination, use `.tap(log(...))` directly.
