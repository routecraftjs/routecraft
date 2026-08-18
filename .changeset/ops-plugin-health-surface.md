---
"@routecraft/routecraft": minor
---

Add the ops plugin: an operational surface mounted on a named server, with health as its first capability.

Enable it with `defineConfig({ ops: {} })`. It needs no application code: route lifecycle, circuit-breaker position and the context's own serving state are all derived from events the framework already emits.

```ts
defineConfig({
  servers: { ops: { port: 9090 } },
  ops: { server: "ops" },
})
```

Five paths, three signals, separated by what acting on the answer does:

- `GET /health`: operational health, every component. What an uptime monitor pages on.
- `GET /health/live`: liveness. 200 while the process is up, and nothing else ever, so a third party going down cannot restart every replica.
- `GET /health/ready`: readiness. Instance-domain components only, because derotating a replica helps only when the peers are in a better position.
- `GET /health/routes/<id>` and `GET /health/indicators/<name>`: one component with its own status code.

Further user-visible details:

- Statuses are `up`, `degraded`, `down`, `inactive`. An exchange error is a route issue, not a health issue: only a dead source (`down`), an open breaker or a deliberate offline (`degraded`) move a route's status. A finished one-shot route reports `inactive` and is excluded from aggregation.
- `defineIndicator({ name })` declares a dependency the framework cannot see, and the handle it returns is the push surface (`up()`, `down()`, `inactive()`). Register handles through `ops.indicators`. Give an indicator a `route` to bind it to a probe route's exchange outcomes and the route needs no health code at all; give it `maxAgeMs` to make silence go stale.
- Per-component `details` maps default to `when-authenticated`, collapsing to `always` on a server with no validator configured (the same collapse the http plugin applies to `/ready`). `always` and `never` are the other settings. Statuses themselves are always served, so a probe with no credential always works.
- The mount claims `/health` and `/ops` exhaustively, so a collision with another surface fails at bind time rather than being decided by dispatch order. `/ops/*` answers 404 until the action surface ships.
- `plugin:ops:health:changed` fires on every component transition, carrying `component`, `name`, `from` and `to`.
- The ledger is published on the store under `OPS_HEALTH_STATE` so other surfaces can read health without going through HTTP.
