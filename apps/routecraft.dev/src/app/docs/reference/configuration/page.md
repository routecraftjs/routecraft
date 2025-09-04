---
title: Configuration
---

Configure RouteCraft contexts with routes and lifecycle handlers. {% .lead %}

## CraftConfig

The main configuration object for creating a CraftContext.

```ts
import { type CraftConfig } from '@routecraftjs/routecraft'
import routes from './routes'

export default {
  routes: routes,
} satisfies CraftConfig
```

## Configuration fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `routes` | `RouteDefinition \| RouteDefinition[]` | Yes | Single route or array of routes to register |
| `on` | `<E>(event: E, handler: (payload) => void) => () => void` | No | Subscribe to context and route lifecycle events |
| `plugins` | `Plugin[] \| PluginFactory[]` | No | Plugins to register with the context for extended functionality |
| `adminPortal` | `AdminPortalConfig \| boolean` | No | Enable admin portal with monitoring and tracing tools |
| `store` | `Map<string, unknown>` | No | Initial values for the context store |

## Environment variables

RouteCraft automatically loads environment variables from `.env` files when using the CLI. Set logging levels and other runtime configuration:

```bash
# .env
LOG_LEVEL=debug
NODE_ENV=development
```

## Admin portal

Enable a web-based admin portal for monitoring and debugging:

```ts
export default {
  routes: myRoutes,
  adminPortal: true, // Enables portal at /admin
} satisfies CraftConfig
```

Access the portal at `http://localhost:3000/admin` (or your configured base URL + `/admin`) for real-time monitoring, tracing, and debugging tools.

## Plugins configuration

Register plugins when manually bootstrapping contexts:

```ts
import observabilityPlugin from './plugins/observability'
import metricsPlugin from './plugins/metrics'

export default {
  routes: myRoutes,
  plugins: [
    observabilityPlugin,
    metricsPlugin,
  ],
} satisfies CraftConfig
```

Plugins can be functions or objects with lifecycle hooks. They receive the context instance for setup.

## Context store

Provide initial values for the shared context store:

```ts
export default {
  routes: myRoutes,
  store: new Map([
    ['app.config', { version: '1.0.0' }],
    ['cache.users', new Map()],
    ['metrics.counters', { requests: 0 }],
  ]),
} satisfies CraftConfig
```

The store is accessible to all routes and adapters via `context.getStore()` and `context.setStore()`.

## Merged options

Some adapters support configuration merging with context-level settings:

```ts
// Adapter can merge its options with context configuration
const adapter = createAdapter({
  options: { timeout: 5000 },
  mergedOptions: (context) => ({
    ...context.getStore('global.http.config'),
    timeout: 5000, // Override specific values
  })
})
```

This pattern allows adapters to inherit global configuration while maintaining local overrides.

## Event handling

Subscribe to context and route lifecycle events using the `on` method:

```ts
import { context } from '@routecraftjs/routecraft'
import routes from './routes'

const ctx = context()
  .routes(routes)
  .build()

// Subscribe to events
ctx.on('contextStarting', ({ ts, context }) => {
  console.log('Context starting at', ts)
})

ctx.on('routeStarted', ({ ts, context, details: { route } }) => {
  console.log(`Route ${route.definition.id} started`)
})

ctx.on('error', ({ ts, context, details: { error, route, exchange } }) => {
  console.error('Error occurred:', error)
})

await ctx.start()
```

### Event signature

All events follow the signature: `{ ts, context, details }` where:
- `ts` - ISO timestamp string for when the event occurred
- `context` - The CraftContext instance
- `details` - Event-specific data (structure varies by event)

### Context events

| Event | Description | Details Structure |
|-------|-------------|-------------------|
| `contextStarting` | Context is beginning startup | `{}` |
| `contextStarted` | Context has completed startup | `{}` |
| `contextStopping` | Context is beginning shutdown | `{ reason }` |
| `contextStopped` | Context has fully stopped | `{}` |

### Route events

| Event | Description | Details Structure |
|-------|-------------|-------------------|
| `routeRegistered` | Route has been registered | `{ route }` |
| `routeStarting` | Route is about to start | `{ route }` |
| `routeStarted` | Route has started successfully | `{ route }` |
| `routeStopping` | Route is stopping | `{ route, reason, exchange }` |
| `routeStopped` | Route has stopped | `{ route, exchange }` |

### System events

| Event | Description | Details Structure |
|-------|-------------|-------------------|
| `error` | Any error occurred in the system | `{ error, route?, exchange? }` |

For practical monitoring examples and plugin patterns, see the [Monitoring](/docs/introduction/monitoring) guide.
