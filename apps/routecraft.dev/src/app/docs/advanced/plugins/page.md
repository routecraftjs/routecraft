---
title: Plugins
---

Extend the Routecraft runtime with cross-cutting behaviour. {% .lead %}

## What is a plugin?

A plugin is code that runs once when the context starts, before any capabilities are registered. It has access to the full `CraftContext` and can:

- Subscribe to lifecycle events (capability started, error occurred, context stopped)
- Write shared state to the context store for adapters to read
- Register additional capabilities dynamically

**Plugins vs capabilities:** a capability defines what your system does. A plugin extends how the runtime behaves. Logging, metrics, tracing, auth headers, and connection pooling are all plugin concerns, not capability concerns.

## Writing a plugin

A plugin is a function that receives the context:

```ts
// plugins/logger.ts
import { type CraftContext } from '@routecraft/routecraft'

export default function loggerPlugin(context: CraftContext) {
  context.on('route:started', ({ details: { route } }) => {
    context.logger.info(`Started: ${route.definition.id}`)
  })

  context.on('error', ({ details: { error, route } }) => {
    context.logger.error(error, `Error in ${route?.definition.id ?? 'context'}`)
  })
}
```

Or as an object if you need a `register` step:

```ts
// plugins/metrics.ts
export default {
  async register(context: CraftContext) {
    context.setStore('metrics.counters', { started: 0, errors: 0 })

    context.on('route:started', ({ context }) => {
      const counters = context.getStore('metrics.counters') as any
      counters.started += 1
    })
  },
}
```

## Registering a plugin

Pass plugins in `craft.config.ts`:

```ts
// craft.config.ts
import type { CraftConfig } from '@routecraft/routecraft'
import logger from './plugins/logger'
import metrics from './plugins/metrics'

const config: CraftConfig = {
  plugins: [logger, metrics],
}

export default config
```

## Setting global adapter defaults

The most common plugin pattern is writing to the context store so adapters can read global configuration instead of requiring it per-capability.

```ts
// plugins/defaults.ts
export default function defaults(context: CraftContext) {
  context.setStore('db.config', {
    connectionString: process.env.DB_URL,
    poolSize: 10,
  })

  context.setStore('api.defaults', {
    headers: { Authorization: `Bearer ${process.env.API_TOKEN}` },
  })
}
```

An adapter reads it at call time:

```ts
class DbAdapter implements Destination<any, void> {
  async send(exchange) {
    const config = exchange.context.getStore('db.config') as { connectionString: string }
    await db(config.connectionString).insert(exchange.body)
  }
}
```

This keeps connection strings and tokens out of every capability file.

## Managing external services

Plugins can manage long-lived external processes. The built-in `mcpPlugin` demonstrates this pattern: it spawns stdio MCP server subprocesses, monitors their health, and restarts them with exponential backoff when they crash.

```ts
import { mcpPlugin } from '@routecraft/ai'

const config: CraftConfig = {
  plugins: [
    mcpPlugin({
      clients: {
        filesystem: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        },
      },
      maxRestarts: 5,
    }),
  ],
}
```

The plugin starts each subprocess when the context starts and tears them down when it stops. Tools from all sources (local routes, stdio clients, HTTP clients) are collected into a unified registry accessible from the context store.

## Lifecycle events

Plugins subscribe to events using `context.on(eventName, handler)`. Common events include `route:started`, `route:stopped`, `context:started`, `context:stopped`, and `error`. See the [Events reference](/docs/reference/events) for the full list.

## Dynamically registering capabilities

Because plugins run before capabilities are registered, they can add capabilities to the context at startup:

```ts
// plugins/admin.ts
export default function adminPlugin(context: CraftContext) {
  if (process.env.ENABLE_ADMIN === 'true') {
    context.registerRoutes(
      craft()
        .id('admin-health')
        .from(simple({ ok: true }))
        .to(log())
        .build()[0]
    )
  }
}
```

---

## Related

{% quick-links %}

{% quick-link title="Plugins reference" icon="presets" href="/docs/reference/plugins" description="Full API for plugin interfaces and context methods." /%}
{% quick-link title="Monitoring" icon="theming" href="/docs/introduction/monitoring" description="Observability patterns built on plugins and events." /%}

{% /quick-links %}
