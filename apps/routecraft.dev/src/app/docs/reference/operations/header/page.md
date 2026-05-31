---
title: header
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
header(key: string, valueOrFn: HeaderValue | ((exchange: Exchange<Current>) => HeaderValue | Promise<HeaderValue>)): RouteBuilder<Current>
```

Set or override a header on the exchange. The body remains unchanged.

```ts
// Static header
.header('x-env', 'prod')

// Derived from body
.header('user.id', (exchange) => exchange.body.id)

// Derived from headers
.header('correlation', (exchange) => exchange.headers['x-request-id'])

// Async derived value
.header('request.trace', async (exchange) => await computeTrace(exchange.body))

// Override an existing header later in the chain
.header('x-env', 'staging')
```
