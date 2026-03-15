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

## Telemetry plugin

The built-in `telemetry()` plugin persists every framework event to a local SQLite database so you can inspect execution history after the fact -- or in real time via `craft tui`.

```ts
import { CraftContext, telemetry } from '@routecraft/routecraft'

const ctx = new CraftContext({
  plugins: [telemetry()],
})
```

The database is written to `.routecraft/telemetry.db` in the current working directory. You can change this and other defaults:

```ts
telemetry({
  dbPath: './logs/telemetry.db', // custom path
  batchSize: 100,                // events buffered before flush (default 50)
  flushIntervalMs: 2000,         // max ms between flushes (default 1000)
  walMode: true,                 // WAL mode for concurrent reads (default true)
})
```

`better-sqlite3` must be installed as it is an optional peer dependency:

```bash
npm install better-sqlite3
```

Once the plugin is active, launch the terminal UI in a separate terminal to browse routes, exchanges, and the live event stream:

```bash
craft tui
```

See the [Terminal UI guide](/docs/introduction/tui) for navigation and options.

---

## Related

{% quick-links %}

{% quick-link title="Events reference" icon="presets" href="/docs/reference/events" description="Full event catalog with payload shapes and wildcard patterns." /%}
{% quick-link title="Plugins" icon="plugins" href="/docs/advanced/plugins" description="How to write and register plugins." /%}
{% quick-link title="Terminal UI" icon="installation" href="/docs/introduction/tui" description="Browse routes, exchanges, and live events from the terminal." /%}

{% /quick-links %}
