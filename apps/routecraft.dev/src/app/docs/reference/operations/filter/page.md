---
title: filter
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
filter(fn: Filter<Current> | CallableFilter<Current>): RouteBuilder<Current>
```

Filter exchanges based on a predicate. The predicate receives the full `Exchange` object, allowing you to filter based on headers, body, or other exchange properties.

Return `true` to keep the exchange, `false` to drop it, or `{ reason: "..." }` to drop with an explanation that is recorded in telemetry and shown in the TUI.

```ts
// Simple boolean filter
.filter((exchange) => exchange.body.isActive)

// Drop with a reason (shown in TUI traces)
.filter((exchange) => {
  if (!exchange.body.name) return { reason: "name is required" };
  if (exchange.body.age < 18) return { reason: "age must be 18 or older" };
  return true;
})

// Async filter
.filter(async (exchange) => await isValidOrder(exchange.body))

// Filter based on headers
.filter((exchange) => exchange.headers['x-priority'] === 'high')
```

{% callout type="note" title="Filter vs Transform" %}
Unlike `.transform()` which receives only the body, `.filter()` receives the full `Exchange` object. This allows filtering based on headers, correlation IDs, or other exchange metadata, not just the message body.
{% /callout %}
