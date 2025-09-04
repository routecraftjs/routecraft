---
title: Events
---

Lifecycle and runtime events for contexts and routes. {% .lead %}

## Subscribing to events

Use `context.on(event, handler)` to subscribe. Handlers receive `{ ts, context, details }`.

```ts
import { context } from '@routecraftjs/routecraft'
import routes from './routes'

const ctx = context()
  .routes(routes)
  .build()

ctx.on('contextStarting', ({ ts }) => {
  console.log('Context starting at', ts)
})

ctx.on('routeStarted', ({ details: { route } }) => {
  console.log(`Route ${route.definition.id} started`)
})

ctx.on('error', ({ details: { error } }) => {
  console.error('Error occurred:', error)
})

await ctx.start()
```

## Event signature

All events follow `{ ts, context, details }` where:
- `ts`: ISO timestamp string for when the event occurred
- `context`: The `CraftContext` instance
- `details`: Event-specific data (varies by event)

## Context events

| Event | Description | Details |
| --- | --- | --- |
| `contextStarting` | Context is beginning startup | `{}` |
| `contextStarted` | Context has completed startup | `{}` |
| `contextStopping` | Context is beginning shutdown | `{ reason }` |
| `contextStopped` | Context has fully stopped | `{}` |

## Route events

| Event | Description | Details |
| --- | --- | --- |
| `routeRegistered` | Route has been registered | `{ route }` |
| `routeStarting` | Route is about to start | `{ route }` |
| `routeStarted` | Route has started successfully | `{ route }` |
| `routeStopping` | Route is stopping | `{ route, reason, exchange }` |
| `routeStopped` | Route has stopped | `{ route, exchange }` |

## System events

| Event | Description | Details |
| --- | --- | --- |
| `error` | Any error occurred in the system | `{ error, route?, exchange? }` |

For monitoring patterns and plugin examples, see [/docs/introduction/monitoring](/docs/introduction/monitoring) and [/docs/reference/plugins](/docs/reference/plugins).


