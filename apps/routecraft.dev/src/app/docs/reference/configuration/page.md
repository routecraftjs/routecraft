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

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `routes` | `RouteDefinition \| RouteDefinition[]` | Yes | — | Single route or array of routes to register |
| `plugins` | `Plugin[] \| PluginFactory[]` | No | `[]` | Plugins registered on context startup |
| `adminPortal` | `AdminPortalConfig \| boolean` | No | `false` | Enables admin portal with monitoring and tracing tools |
| `store` | `Map<string, unknown>` | No | `new Map()` | Initial values for the context store |
| `on` | `<E>(event: E, handler: (payload) => void) => () => void` | No | — | Subscribe to context and route lifecycle events (also available at runtime via context) |

## Environment variables

RouteCraft automatically loads environment variables from `.env` files when using the CLI. Set logging levels and other runtime configuration:

```bash
# .env
LOG_LEVEL=debug
NODE_ENV=development
```

## Adapters and plugins

- Adapters are not auto-loaded. Import and instantiate them explicitly in routes (e.g., `from(timer(...))`, `to(log())`).
- Plugins are auto-loaded if present under a `plugins/` directory when using the CLI. You can also pass plugins explicitly via the `plugins` field. Plugins can extend the context (e.g., add stores, register event hooks).

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

Plugins can be functions or objects with a `register` method and lifecycle hooks. They receive the context instance for setup and can extend context stores or subscribe to events.

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

## Events

See the dedicated Events reference for details, signatures, and examples: [/docs/reference/events](/docs/reference/events)
