---
title: Monitoring
---

Log and observe your capabilities at runtime. {% .lead %}

## Capability-level logging

Use `tap(log())` anywhere in a capability to emit a structured log of the current exchange without altering it. Use `tap(debug())` for verbose output you only want visible at debug level. Both can also be used as a final destination with `.to()`.

```ts
import { craft, simple, log, debug } from '@routecraft/routecraft'

export default craft()
  .id('order-pipeline')
  .from(simple({ orderId: '123' }))
  .tap(debug())              // debug-level: verbose, filtered out by default
  .transform(enrichOrder)
  .tap(log())                // info-level: visible in normal operation
  .to(log())                 // log the final exchange as the destination
```

Each log entry includes `contextId`, `routeId`, `exchangeId`, and `correlationId` for end-to-end tracing in your log aggregator.

To set the log level, pass `--log-level` to the CLI:

```bash
craft run ./capabilities/orders.ts --log-level debug
```

## Subscribing to events

Use the `on` property in `craft.config.ts` to react to lifecycle and error events without writing a plugin:

```ts
// craft.config.ts
import type { CraftConfig } from '@routecraft/routecraft'

export const craftConfig: CraftConfig = {
  on: {
    'context:started': ({ ts }) => {
      console.log(`Ready at ${ts}`)
    },
    'error': ({ details: { error, route } }) => {
      console.error(`Error in ${route?.definition.id ?? 'context'}`, error)
    },
    'route:*:exchange:failed': ({ details: { routeId, error } }) => {
      alerts.send(routeId, error)
    },
  },
}
```

For the full event catalog see the [Events reference](/docs/reference/events).

## Observability plugin

For reusable observability logic, encapsulate it in a plugin:

```ts
// plugins/observability.ts
import { type CraftContext } from '@routecraft/routecraft'

export default function observability(ctx: CraftContext) {
  ctx.on('route:started', ({ details: { route } }) => {
    metrics.increment('route.started', { route: route.definition.id })
  })

  ctx.on('error', ({ details: { error, route } }) => {
    alerts.send({
      route: route?.definition.id,
      code: error?.code,
      message: error?.message,
    })
  })

  ctx.on('context:stopped', () => {
    metrics.flush()
  })
}
```

Register it in `craft.config.ts`:

```ts
import observability from './plugins/observability'
import type { CraftConfig } from '@routecraft/routecraft'

export const craftConfig: CraftConfig = {
  plugins: [observability],
}
```

---

## Related

{% quick-links %}

{% quick-link title="Events reference" icon="presets" href="/docs/reference/events" description="Full event catalog with payload shapes and wildcard patterns." /%}
{% quick-link title="Plugins" icon="plugins" href="/docs/advanced/plugins" description="How to write and register plugins." /%}

{% /quick-links %}
