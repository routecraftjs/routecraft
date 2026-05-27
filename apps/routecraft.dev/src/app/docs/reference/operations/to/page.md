---
title: to
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
to<R = void>(
  destination: Destination<Current, R> | CallableDestination<Current, R>
): RouteBuilder<R>
```

Send the exchange to a destination. If the destination returns `undefined`, the exchange continues unchanged. If it returns a value, the exchange body is replaced with that value.

**Destinations returning void (side-effect only):**

```ts
.to(log()) // Log the final result
.to(saveToDB) // Insert into database, returns void
.to(async (exchange) => {
  await sendToWebhook(exchange);
  // No return = undefined = body unchanged
})
```

**Destinations returning data (body replacement):**

When a destination returns a value (not `undefined`), the exchange body is **replaced** with that value.

```ts
// http returns HttpResult - body becomes HttpResult
.to(http({ url: 'https://api.example.com/transform' }))

// Custom adapter returns ID - body becomes the ID
.to(saveToDBReturnID)

// Custom transformation
.to(async (exchange) => {
  const result = await processData(exchange.body);
  return result; // Body replaced with result
})
```

**Chaining .to() calls:**

```ts
// Each .to() can transform the body if it returns a value
.to(async (ex) => ({ ...ex.body, step: 1 }))
.to(async (ex) => ({ ...ex.body, step: 2 }))
// Body accumulates changes from each .to() that returns data

// Mix side-effects and transformations
.to(saveToDB) // Returns void, body unchanged
.to(http({ url: 'https://api.example.com/enrich' })) // Body becomes HttpResult
.to(log()) // Logs the HttpResult
```

**Note:** Unlike `.enrich()`, `.to()` does not merge results. If the destination returns a value, it completely replaces the body.

{% callout type="warning" title="Multiple .to() per route not recommended" %}
While technically possible, using multiple `.to()` operations in a single route is not advised. We recommend one `.to()` per route for clarity. Consider using `.enrich()` for intermediate data fetching or `.tap()` for side effects.

An ESLint rule `@routecraft/routecraft/single-to-per-route` is available to warn when multiple `.to()` operations are used.
{% /callout %}
