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

The most common plugin pattern is setting default options for adapters. Built-in adapters that support this ship a companion plugin function:

```ts
// craft.config.ts
import type { CraftConfig } from '@routecraft/routecraft'
import { cronPlugin } from '@routecraft/routecraft'
import { llmPlugin } from '@routecraft/ai'

const config: CraftConfig = {
  plugins: [
    cronPlugin({ timezone: 'UTC', jitterMs: 2000 }),
    llmPlugin({
      providers: { anthropic: { apiKey: process.env.ANTHROPIC_API_KEY } },
      defaultOptions: { temperature: 0.7 },
    }),
  ],
}

export default config
```

Every `cron()` source and `llm()` destination in the context inherits those defaults unless overridden per-adapter. This keeps shared configuration out of every capability file.

For the full pattern -- how merged options work, which adapters support them, and how to add support to a custom adapter -- see the [Merged Options guide](/docs/advanced/merged-options).

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
