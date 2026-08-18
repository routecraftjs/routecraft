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

- The report carries `view` and `status`; there is no separate `ready` flag, because it would be exactly `status !== "down"` and a derivable field of that name on the operational aggregate invites routing traffic on the deployment-wide signal.
- Statuses are `up`, `degraded`, `down`, `inactive`. An exchange error is a route issue, not a health issue: only a dead source (`down`), an open breaker or a deliberate offline (`degraded`) move a route's status. A finished one-shot route reports `inactive` and is excluded from aggregation.
- `defineIndicator({ name })` declares a dependency the framework cannot see, and the handle it returns is the push surface (`up()`, `down()`, `inactive()`). Register handles through `ops.indicators`. Give an indicator a `route` to bind it to a probe route's exchange outcomes and the route needs no health code at all; give it `maxAgeMs` to make silence go stale.
- Per-component `details` maps default to `when-authenticated`, collapsing to `always` on a server with no validator configured (the same collapse the http plugin applies to `/ready`). `always` and `never` are the other settings. Statuses themselves are always served, so a probe with no credential always works.
- The mount claims `/health` and `/ops` exhaustively, so a collision with another surface fails at bind time rather than being decided by dispatch order. `/ops/*` answers 404 until the action surface ships.
- The http plugin now declares its `/health`, `/ready` and `/openapi.json` built-ins as mount claims, so another surface can no longer shadow them silently on dispatch score. The ops surface is the one deliberate exception: with both plugins on one server the http `/health` built-in stands down and ops answers that path, since the report is a strict superset of the constant. `WebIngress` gains `hasMount(id)` so a surface can make that decision from inside its `claims()` thunk.
- `defineIndicator` refuses a name that is not usable as a single URL path segment, since the name is the last segment of `/health/indicators/<name>`.
- A handle declared with `defineIndicator` but never listed in `ops.indicators` is reported at context start. Pushing through an unregistered handle is inert by design, so without the report the surface would look instrumented while watching nothing.
- A server carrying `health.details: "when-authenticated"` with no validator configured warns at start, because the configured value reads back as a gate while behaving as `always`.
- `plugin:ops:health:changed` fires on every component transition, carrying `component`, `name`, `from` and `to`.
- The ledger is published on the store under `OPS_HEALTH_STATE` so other surfaces can read health without going through HTTP.
