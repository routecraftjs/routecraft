---
title: Plugins
---

Extend RouteCraft with cross-cutting behavior using plugins. {% .lead %}

## What is a plugin?

A plugin can augment the `CraftContext` by:
- Registering event listeners
- Adding shared stores
- Exposing utilities to routes/adapters

Plugins are either:
- A function `(context) => void | Promise<void>`
- An object with `register(context)` and optional lifecycle hooks

## File-based auto-loading

When using the CLI, plugins are auto-loaded if present in a `plugins/` directory at your project root (or within `src/plugins` if you use a `src` directory). You can also pass plugins explicitly via `CraftConfig.plugins`.

```ts
// craft.config.ts
import routes from './routes'
import metrics from './plugins/metrics'

export default {
  routes,
  plugins: [metrics],
}
```

## Structure

Function style:

```ts
// plugins/logger.ts
import { type CraftContext } from '@routecraftjs/routecraft'

export default async function loggerPlugin(context: CraftContext) {
  context.on('routeStarted', ({ details: { route } }) => {
    context.logger.info(`Started: ${route.definition.id}`)
  })
}
```

Object style:

```ts
// plugins/metrics.ts
import { type CraftContext } from '@routecraftjs/routecraft'

export default {
  async register(context: CraftContext) {
    context.setStore('metrics.counters', { started: 0 })
    context.on('routeStarted', ({ context }) => {
      const counters = context.getStore('metrics.counters') as { started: number }
      counters.started += 1
    })
  },
}
```

## Lifecycle hooks

Plugins can subscribe to the Events API and handle:
- Context lifecycle: `contextStarting`, `contextStarted`, `contextStopping`, `contextStopped`
- Route lifecycle: `routeRegistered`, `routeStarting`, `routeStarted`, `routeStopping`, `routeStopped`
- System: `error`

See [/docs/reference/events](/docs/reference/events) for full signatures.

## Setting adapter defaults via the context store

Plugins are a great place to set configuration defaults that adapters can consume, such as database connection details or API auth.

```ts
// plugins/defaults.ts
import { type CraftContext } from '@routecraftjs/routecraft'

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

Adapters can read these defaults via the context. If an adapter implements a merged options pattern, it can combine global defaults with local options.

```ts
// Example adapter merging store defaults
import { type CraftContext, type MergedOptions } from '@routecraftjs/routecraft'

interface DbOptions { connectionString: string; poolSize?: number }

class DbAdapter implements MergedOptions<DbOptions> {
  constructor(public options: Partial<DbOptions> = {}) {}
  mergedOptions(context: CraftContext): DbOptions {
    const defaults = (context.getStore('db.config') as Partial<DbOptions>) || {}
    return { connectionString: '', poolSize: 10, ...defaults, ...this.options }
  }
}
```

Routes can also access defaults in processing steps:

```ts
craft()
  .from(simple({ path: '/resource' }))
  .process((ex) => {
    const api = ex.context.getStore('api.defaults') as { headers?: Record<string,string> }
    return { ...ex.body, headers: { ...api?.headers } }
  })
```

## Best practices

- Keep plugins focused (logging, metrics, tracing)
- Avoid hidden side effects in routes; use events instead
- Use the context store to share state between routes/adapters

## Example: simple logging plugin

```ts
// plugins/simple-logger.ts
import { type CraftContext } from '@routecraftjs/routecraft'

export default function simpleLogger(context: CraftContext) {
  context.on('error', ({ details: { error } }) => {
    context.logger.error(error, 'RouteCraft error')
  })
}
```


