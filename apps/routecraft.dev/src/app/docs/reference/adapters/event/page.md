---
title: event
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
import { event } from '@routecraft/routecraft'
```

Produce exchanges from framework events. Use as the source with `.from(event(filter))`; the exchange body is the event payload.

```ts
// Single event
craft().from(event('route:started')).to(log())

// Multiple events
craft().from(event(['route:started', 'route:stopped'])).to(log())
```

**Filter (`EventFilter`):** an event name, an array of names, or a wildcard pattern.

- `*` (single-level) matches exactly one colon-separated segment: `route:*` matches `route:started` but not `route:exchange:started`.
- `**` (globstar) matches zero or more segments at any depth: `route:**` matches every route event; `route:*:operation:**` matches operations at any adapter depth.
- `*` on its own matches all events.

Event names are a fixed set (identity such as the route id lives in the payload), so patterns match against the emitted name behind a single catch-all subscription; to scope to one route, filter on `details.routeId` in a downstream step. The `event()` adapter is the only place wildcard patterns survive; `ctx.on()` accepts exact names plus the catch-all `'*'`. See the [Events reference](/docs/reference/events) for the full taxonomy.
