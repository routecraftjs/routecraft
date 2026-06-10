---
title: Events
---

Observe and react to what happens inside the runtime without touching capability code. {% .lead %}

## What is the event system?

Every significant thing that happens in Routecraft emits an event: context startup, capability lifecycle, individual exchange progress, retry attempts, batch flushes. You can subscribe to any of these from a plugin, an adapter, or anywhere you have access to the `CraftContext`.

Events are the primary hook for cross-cutting concerns: logging, metrics, tracing, alerting, and audit trails.

## Subscribing via craft config

The simplest way to react to events is via the `on` property in `craft.config.ts`. This works with `craft run` out of the box -- no plugin required.

```ts
// craft.config.ts
import type { CraftConfig } from '@routecraft/routecraft'

const config: CraftConfig = {
  on: {
    'context:started': ({ ts }) => {
      console.log(`Context ready at ${ts}`)
    },
    'error': ({ details: { error, route } }) => {
      console.error(`Error in ${route?.definition.id ?? 'context'}`, error)
    },
    'route:exchange:failed': ({ details: { routeId, error } }) => {
      alerts.send(routeId, error)
    },
  },
}

export default config
```

Each key is an event name (or the catch-all `'*'`). The value can be a single handler or an array of handlers.

## Subscribing via a plugin

When you need the full context API (dynamic subscriptions, `context.once`, cleanup), use a plugin instead:

Call `context.on(event, handler)` with an event name or pattern. The handler receives `{ ts, context, details }`.

```ts
// plugins/logger.ts
import { type CraftContext } from '@routecraft/routecraft'

export default function loggerPlugin(ctx: CraftContext) {
  ctx.on('context:started', ({ ts }) => {
    ctx.logger.info(`Context ready at ${ts}`)
  })

  ctx.on('route:started', ({ details: { route } }) => {
    ctx.logger.info(`Capability running: ${route.definition.id}`)
  })

  ctx.on('error', ({ details: { error, route } }) => {
    ctx.logger.error(error, `Error in ${route?.definition.id ?? 'context'}`)
  })
}
```

Use `context.once` when you only need the first occurrence:

```ts
ctx.once('context:started', () => {
  console.log('Ready -- fires once only')
})
```

To unsubscribe, call the function returned by `context.on`:

```ts
const unsub = ctx.on('route:started', handler)
unsub() // stops receiving events
```

## Event naming convention

Event names are colon-separated segments that describe scope from broad to specific:

```text
context:started
route:started
route:{capabilityId}:exchange:completed
route:{capabilityId}:operation:to:{adapterId}:stopped
route:{capabilityId}:operation:retry:attempt
plugin:started
```

Event names are a fixed, finite set: identity (the route id, the plugin id, the step label) always lives in the payload, never in the name. That is what makes subscriptions strictly typed and the emit path fast.

## Filtering by identity

Subscribe to exact names; narrow to one capability with `forRoute()` (or any payload predicate). The catch-all `'*'` observes every event for audit-style sinks.

```ts
import { forRoute } from '@routecraft/routecraft'

// Every event emitted by the runtime
ctx.on('*', ({ ts, details }) => {
  audit.write({ ts, details })
})

// Exchange failures for one specific capability
ctx.on('route:exchange:failed', forRoute('order-processor', ({ details }) => {
  alerts.send(details.error)
}))

// Exchange completed or failed on any capability
ctx.on('route:exchange:completed', ({ details }) => {
  metrics.increment('exchange.completed')
})
ctx.on('route:exchange:failed', ({ details: { error } }) => {
  alerts.send(error)
})
```

## Emitting custom events from plugins

Plugins can emit their own events on the context for other plugins or adapters to observe:

```ts
// plugins/auth.ts
export default function authPlugin(ctx: CraftContext) {
  ctx.on('route:started', ({ details: { route } }) => {
    // Emit a custom event that other plugins can subscribe to
    ctx.emit('plugin:auth:capability:secured', {
      capabilityId: route.definition.id,
    })
  })
}
```

Any subscriber using `plugin:auth:**` or `plugin:auth:capability:secured` will receive it.

## Adapter metadata in operation events

Adapters can expose structured metadata that is included in their operation events. This is useful for enriching traces or logs with adapter-specific context like HTTP status codes, response sizes, or queue depths.

```ts
import { type Destination, type Exchange } from '@routecraft/routecraft'

class HttpStorageAdapter implements Destination<any, void> {
  readonly adapterId = 'my.http-storage'

  async send(exchange: Exchange) {
    const res = await fetch(this.url, { method: 'POST', body: JSON.stringify(exchange.body) })
    this.lastStatus = res.status
  }

  getMetadata(): Record<string, unknown> {
    return { statusCode: this.lastStatus }
  }
}
```

The metadata appears under `details.metadata` in the corresponding `operation:to:{adapterId}:stopped` event.

## Common patterns

### Log every exchange result

```ts
ctx.on('route:exchange:completed', ({ details: { routeId, exchangeId, duration } }) => {
  logger.info({ routeId, exchangeId, duration }, 'exchange completed')
})

ctx.on('route:exchange:failed', ({ details: { routeId, exchangeId, error } }) => {
  logger.error({ routeId, exchangeId, error }, 'exchange failed')
})
```

### Count retries

```ts
ctx.on('route:retry:attempt', ({ details: { routeId, attemptNumber } }) => {
  metrics.increment(`retry.attempt`, { routeId })
})
```

### Alert on batch flush

```ts
ctx.on('route:batch:flushed', ({ details: { routeId, batchSize, reason } }) => {
  if (reason === 'time' && batchSize < 10) {
    alerts.warn(`Low throughput on ${routeId}: only ${batchSize} items in batch`)
  }
})
```

---

## Related

{% quick-links %}

{% quick-link title="Events reference" icon="presets" href="/docs/reference/events" description="Full event catalog with all payload shapes and filtering patterns." /%}

{% /quick-links %}
