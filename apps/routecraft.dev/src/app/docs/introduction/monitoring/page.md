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

Each log includes trace-friendly fields like `contextId`, `route` (route name/id), and for exchanges also `exchangeId` and `correlationId`.

## Context and route events

Subscribe to context and route lifecycle events for metrics, monitoring, and observability.

```ts
import { context, logger } from '@routecraft/routecraft'
import routes from './routes'

const ctx = context()
  .routes(routes)
  .build()

// Subscribe to events
ctx.on('context:starting', ({ ts, context }) => {
  logger.info('Context starting', { contextId: context.contextId, ts })
})

ctx.on('route:starting', ({ ts, context, details: { route } }) => {
  logger.info('Route starting', { contextId: context.contextId, route: route.definition.id, ts })
})

ctx.on('error', ({ ts, context, details: { error, route, exchange } }) => {
  const code = error?.code || 'UNKNOWN'
  logger.error('Error occurred', { 
    contextId: context.contextId, 
    route: route?.definition.id, 
    code, 
    error, 
    ts 
  })
})

await ctx.start()
```

### Available events

All events follow the signature: `{ ts, context, details }` where `details` contains event-specific data. Key events include:

- **Context lifecycle**: `context:starting`, `context:started`, `context:stopping`, `context:stopped`
- **Route lifecycle**: `route:registered`, `route:starting`, `route:started`, `route:stopping`, `route:stopped`
- **System events**: `error` for any error that occurs

For the complete event reference with all details structures, see the [Events reference](/docs/reference/events).

## Plugins

Keep observability concerns modular by authoring small plugins that receive the `CraftContext`. Plugins run **before routes are registered**, allowing them to set up state, subscribe to lifecycle events, or dynamically register additional routes.

```ts
// plugins/observability.ts
import { logger, type CraftContext } from '@routecraft/routecraft'

export default function observability(ctx: CraftContext) {
  logger.info('Observability plugin initializing', { contextId: ctx.contextId })
  
  // Subscribe to events for monitoring
  ctx.on('route:started', ({ ts, context, details: { route } }) => {
    // Track route startup metrics
    console.log(`Route ${route.definition.id} started at ${ts}`)
  })

  ctx.on('error', ({ ts, context, details: { error, route, exchange } }) => {
    // Send errors to external monitoring service
    const code = error?.code || 'UNKNOWN'
    const location = route ? `route ${route.definition.id}` : 'context'
    console.error(`Error ${code} in ${location}:`, error)
  })

  ctx.on('context:stopped', ({ ts, context }) => {
    // Flush metrics before shutdown
    console.log(`Context ${context.contextId} stopped, flushing metrics...`)
  })
}
```

## Built-in logging and tracing

The CLI and Next.js runtimes include structured logging out of the box (Pino). In development logs are pretty-printed; in production they are JSON. Log records carry `contextId`, `route`, and (for exchanges) `exchangeId`/`correlationId`, which makes end-to-end tracing straightforward in your log aggregator.

### Logging rules (framework and adapters)

- **Error message is the log message**: At error boundaries, the log message is the error's message (e.g. "Redis connection refused", "Model not found"). Variable context (route, operation, adapter) is in the **meta** (first argument object). Non-error logs use stable message strings with context in meta.
- **One log per event**: Each event is logged once. The boundary that handles the error logs it (e.g. route.runSteps for step failures). Never catch, log, and re-throw the same error.
- **Structured error in meta**: Put the error in meta (e.g. `{ err, operation, adapter }`). RouteCraftError implements `toJSON()` so `rc`, `message`, `suggestion`, `docs`, `causeMessage`, `causeStack` appear as structured fields in serialized output.
- **Levels**: `fatal` = context or route failed to start; `error` = operation failed (step, adapter, invalid plugin); `warn` = unexpected but processing continues; `info` = notable state (context/route start and stop — same level for start and stop); `debug` = flow/diagnostic.
- **Validation errors**: When throwing RC5002 (validation failed), the cause is serialized (e.g. validation issues as JSON) so logs show actual errors, not `[object Object]`.

See [Errors](/docs/reference/errors) for RC codes and suggestions. For the full rule, see the project's errors-logging rule.

---

## Related

{% quick-links %}

{% quick-link title="Events reference" icon="presets" href="/docs/reference/events" description="Full event catalog with payload shapes and wildcard patterns." /%}

{% /quick-links %}
