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
craft --log-level debug run ./capabilities/orders.ts
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

## Writing a custom monitoring plugin

If event subscriptions in `craft.config.ts` become unwieldy, extract them into a plugin so they can be reused across projects:

```ts
// plugins/monitoring.ts
import { type CraftContext } from '@routecraft/routecraft'

export default function monitoring(ctx: CraftContext) {
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

Then register it in `craft.config.ts`:

```ts
import monitoring from './plugins/monitoring'
import type { CraftConfig } from '@routecraft/routecraft'

export const craftConfig: CraftConfig = {
  plugins: [monitoring],
}
```

## Telemetry plugin

The built-in `telemetry()` plugin instruments the framework with [OpenTelemetry](https://opentelemetry.io/) traces and persists data to a local SQLite database for `craft tui`.

```ts
import { telemetry } from '@routecraft/routecraft'

export const craftConfig = {
  plugins: [telemetry()],
}
```

The database is written to `.routecraft/telemetry.db` in the current working directory. `better-sqlite3` must be installed:

```bash
pnpm add better-sqlite3
```

### Configuration

```ts
telemetry({
  sqlite: {
    dbPath: './logs/telemetry.db',  // custom path (default .routecraft/telemetry.db)
    eventBatchSize: 100,            // events buffered before flush (default 50)
    eventFlushIntervalMs: 2000,     // max ms between flushes (default 1000)
    maxExchanges: 50_000,           // rows to retain (default 50000, 0 to disable)
    maxEvents: 100_000,             // rows to retain (default 100000, 0 to disable)
  },
})
```

### Exporting traces to an external provider

Because the telemetry plugin uses OpenTelemetry, you can export traces to any OTel-compatible backend alongside the local SQLite database. Install the OTel SDK and an OTLP exporter:

```bash
pnpm add @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-http
```

Then configure a `TracerProvider` and pass it to `telemetry()`. Here is an example using [Better Stack](https://betterstack.com/):

```ts
import { telemetry } from '@routecraft/routecraft'
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'

const tracerProvider = new BasicTracerProvider()
tracerProvider.addSpanProcessor(
  new BatchSpanProcessor(
    new OTLPTraceExporter({
      url: 'https://in-otel.logs.betterstack.com/traces',
      headers: { Authorization: 'Bearer <YOUR_SOURCE_TOKEN>' },
    })
  )
)
tracerProvider.register()

export const craftConfig = {
  plugins: [telemetry({ tracerProvider })],
}
```

This sends OTel traces to Better Stack while keeping the local SQLite database for the TUI. The same pattern works with Grafana Tempo, Datadog, Jaeger, or any backend that accepts OTLP. Just change the exporter URL and headers.

To disable the SQLite backend entirely (external only):

```ts
telemetry({ tracerProvider, disableSqlite: true })
```

### What gets traced

The plugin creates OTel spans for:

- **Route lifecycle**: registration, start, stop (long-lived spans)
- **Exchange lifecycle**: start, complete, fail, drop (per-message spans with duration)
- **Step execution**: each adapter operation as a child span (from, to, process, filter, etc.)

Span attributes use the `routecraft.*` namespace (`routecraft.route.id`, `routecraft.exchange.id`, `routecraft.correlation.id`, etc.) so you can filter and query traces in your provider's UI.

### Terminal UI

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
