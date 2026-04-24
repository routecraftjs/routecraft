---
title: Error Handling
---

Catch pipeline errors and recover gracefully with `.error()`. {% .lead %}

By default, when a step throws an unhandled error, Routecraft logs it and emits `error` and `exchange:failed` events -- then swallows the error so the route keeps running. `.error()` extends this behavior with a custom recovery handler.

## Basic usage

Define `.error()` before `.from()`. When any step in the pipeline throws, the handler is invoked instead:

```ts
craft()
  .id('process-orders')
  .error((error, exchange) => {
    return { status: 'failed', reason: (error as Error).message }
  })
  .from(timer({ intervalMs: 60_000 }))
  .transform(fetchOrders)
  .to(processOrder)
```

The handler's return value becomes the route's final exchange body. The pipeline does not resume after the handler runs.

## Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `error` | `unknown` | The thrown error |
| `exchange` | `Exchange` | The exchange at the point of failure -- headers include route id, correlation id, and operation type |
| `forward` | `(routeId, payload) => Promise<unknown>` | Send a payload to another capability via the direct adapter |

## The `forward` function

The third parameter, `forward`, sends a payload to another capability by route id and returns its result. It uses the direct adapter channel internally -- no extra transport or configuration is needed.

```ts
forward(routeId: string, payload: unknown): Promise<unknown>
```

| Argument | Description |
|----------|-------------|
| `routeId` | The target capability's direct endpoint id (must match the target route's `.id()`) |
| `payload` | Any value -- becomes the target capability's exchange body |
| **returns** | The final exchange body produced by the target capability's pipeline |

`forward` is async. The error handler waits for the target capability to finish processing and returns whatever that capability produces. This means you can use the target's result as the recovery value for the failed capability.

### Example: delegate to a dedicated error capability

```ts
// capabilities/process-orders.ts
craft()
  .id('process-orders')
  .error(async (error, exchange, forward) => {
    // Send failure details to the error capability.
    // forward() returns what the error capability's pipeline produces.
    const result = await forward('errors.orders', {
      originalBody: exchange.body,
      reason: (error as Error).message,
      failedAt: exchange.headers['routecraft.operation'],
    })
    // result is now the recovery value for this capability
    return result
  })
  .from(timer({ intervalMs: 60_000 }))
  .transform(fetchOrders)
  .to(processOrder)
```

```ts
// capabilities/error-orders.ts
craft()
  .id('errors.orders')
  .from(direct({
    description: 'Receives failed order payloads for alerting',
  }))
  .transform((body) => {
    // Log, enrich, or reshape the failure payload
    return { alerted: true, reason: body.reason }
  })
  .to(http({ url: 'https://alerts.example.com/orders' }))
```

In this example, `forward('errors.orders', ...)` sends the failure payload to `errors.orders`, waits for it to run its full pipeline (transform then HTTP call), and returns `{ alerted: true, reason: '...' }` back to the error handler. That value becomes the final exchange body for `process-orders`.

### When not to use `forward`

If you only need to log or return a static fallback, you do not need `forward` at all. Just return a value directly:

```ts
.error((error) => {
  return { status: 'failed', reason: (error as Error).message }
})
```

## When the error handler itself throws

If your `.error()` handler throws, the context takes over:

1. The error is logged
2. The global `error` event fires (same as the default no-handler path)
3. `route:<id>:exchange:failed` fires with the handler's error
4. `route:<id>:operation:error:failed` fires so you can distinguish handler failures from step failures
5. The route stays alive -- it will process the next message normally

This means you always have a safety net. Even a broken error handler cannot crash the route.

## Events

When `.error()` is defined, the following events are emitted instead of the default `error` + `exchange:failed` pair:

| Event | When |
|-------|------|
| `route:<id>:operation:error:invoked` | Error handler is called |
| `route:<id>:operation:error:recovered` | Handler returned successfully |
| `route:<id>:operation:error:failed` | Handler itself threw |

On successful recovery, only `error:invoked` and `error:recovered` fire -- `exchange:failed` does **not** fire because the exchange was recovered.

If the handler throws, all three fire: `error:invoked`, `error:failed`, and `exchange:failed`.

### Subscribing to events

Use `ctx.on()` to listen. Wildcards let you monitor error handling across all routes:

```ts
const ctx = new ContextBuilder()
  .routes(myRoutes)
  .on('route:*:operation:error:invoked', ({ details }) => {
    console.log(
      `Error handler called on ${details.routeId}`,
      `failed at: ${details.failedOperation}`,
    )
  })
  .on('route:*:operation:error:recovered', ({ details }) => {
    console.log(`Recovered: ${details.routeId}`)
  })
  .on('route:*:operation:error:failed', ({ details }) => {
    // The handler itself failed -- alert
    alertOps(`Error handler crashed on ${details.routeId}`, details.originalError)
  })
  .build()
```

For a catch-all, subscribe to the global `error` event. This fires for all unhandled errors and for handler failures:

```ts
ctx.on('error', ({ details }) => {
  console.error('Unhandled error:', details.error)
})
```

---

## Related

{% quick-links %}

{% quick-link title="Composing Capabilities" icon="presets" href="/docs/advanced/composing-capabilities" description="Build modular systems with direct() and reusable capability chains." /%}
{% quick-link title="Events" icon="theming" href="/docs/introduction/events" description="Subscribe to error and exchange lifecycle events." /%}

{% /quick-links %}
