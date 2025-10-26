---
title: Monitoring
---

Log and observe routes. {% .lead %}

## Route-level logging with tap(log())

Use `tap(log())` anywhere in a route to emit structured logs of the current exchange without changing it. You can also use `to(log())` as a destination to log the final exchange.

```ts
import { craft, simple, log } from '@routecraft/routecraft'

export default craft()
  .id('monitoring-demo')
  .from(simple({ foo: 'bar' }))
  .tap(log())
  .transform((body) => ({ ...body, ok: true }))
  .tap(log())
  .to(log())
```

Each log includes trace-friendly fields like `contextId`, `routeId`, and for exchanges also `exchangeId` and `correlationId`.

## Context and route events

Subscribe to context and route lifecycle events for metrics, monitoring, and observability.

```ts
import { context, logger } from '@routecraft/routecraft'
import routes from './routes'

const ctx = context()
  .routes(routes)
  .build()

// Subscribe to events
ctx.on('contextStarting', ({ ts, context }) => {
  logger.info('Context starting', { contextId: context.contextId, ts })
})

ctx.on('routeStarting', ({ ts, context, details: { route } }) => {
  logger.info('Route starting', { contextId: context.contextId, routeId: route.definition.id, ts })
})

ctx.on('error', ({ ts, context, details: { error, route, exchange } }) => {
  const code = error?.code || 'UNKNOWN'
  logger.error('Error occurred', { 
    contextId: context.contextId, 
    routeId: route?.definition.id, 
    code, 
    error, 
    ts 
  })
})

await ctx.start()
```

### Available events

All events follow the signature: `{ ts, context, details }` where `details` contains event-specific data. Key events include:

- **Context lifecycle**: `contextStarting`, `contextStarted`, `contextStopping`, `contextStopped`
- **Route lifecycle**: `routeRegistered`, `routeStarting`, `routeStarted`, `routeStopping`, `routeStopped`
- **System events**: `error` for any error that occurs

For the complete event reference with all details structures, see [Configuration - Event handling](/docs/reference/configuration#event-handling).

## Plugins

Keep observability concerns modular by authoring small plugins that receive the `CraftContext`. Frameworks auto-wire plugins placed under `plugins/`, so you only need to export the function (and optionally an order).

```ts
// plugins/observability.ts
import { logger, type CraftContext } from '@routecraft/routecraft'

// Optional: control initialization order (lower runs earlier)
export const order = 100

export default function observability(ctx: CraftContext) {
  logger.info('Observability plugin ready', { contextId: ctx.contextId })
  
  // Subscribe to events for monitoring
  ctx.on('routeStarted', ({ ts, context, details: { route } }) => {
    // Track route startup metrics
    console.log(`Route ${route.definition.id} started at ${ts}`)
  })
  
  ctx.on('error', ({ ts, context, details: { error, route, exchange } }) => {
    // Send errors to external monitoring service
    const code = error?.code || 'UNKNOWN'
    const location = route ? `route ${route.definition.id}` : 'context'
    console.error(`Error ${code} in ${location}:`, error)
  })
  
  ctx.on('contextStopped', ({ ts, context }) => {
    // Flush metrics before shutdown
    console.log(`Context ${context.contextId} stopped, flushing metrics...`)
  })
}
```

## Built-in logging and tracing

The CLI and Next.js runtimes include structured logging out of the box (Pino). In development logs are pretty-printed; in production they are JSON. Log records carry `contextId`, `routeId`, and (for exchanges) `exchangeId`/`correlationId`, which makes end-to-end tracing straightforward in your log aggregator.
