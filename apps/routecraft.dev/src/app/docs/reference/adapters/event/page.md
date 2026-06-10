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

Static subscriptions (`context:started`, `route:started`, ...) expand wildcards at startup against known event names; hierarchical events (`route:<id>:exchange:<phase>`) need explicit patterns or `**` to match runtime route ids. See the [Events reference](/docs/reference/events) for the full taxonomy.
