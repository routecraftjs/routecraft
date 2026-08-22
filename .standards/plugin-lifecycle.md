# Plugin Lifecycle

A `CraftPlugin` has three phases. Each one runs at a different point in
the context's life, and which one a piece of work belongs in is decided
by what has to already exist for that work to be correct.

| Phase | Runs | The routes are | Use it for |
|-------|------|----------------|------------|
| `apply(ctx)` | While the context is being built, before any route starts | Not registered yet | Resolving config, opening resources, populating the context store |
| `start(ctx)` | After every route has started | Running | Work that drives routes or depends on them being able to serve |
| `teardown(ctx, info)` | During shutdown, or when a build or start failed partway | Stopping, stopped, or never started | Releasing what `apply` opened and stopping what `start` began |

---

## 1. Which phase

The dividing line between `apply` and `start` is whether the work needs a
route to be able to run. Resolving a store handle does not; re-entering a
route's error channel does.

`ContextBuilder.build()` calls `initPlugins()` before `registerRoutes()`, so
during `apply` the builder's routes do not exist yet. A plugin that reads the
route list at `apply` time sees an empty one.

The suspension plugin is the worked example. `apply` resolves the store
and the token signer, so a missing signing secret fails while the context
is still being built rather than after it has accepted traffic. `start`
runs the sweeper's downtime scan, which retires suspensions that came due
while the process was down and re-enters each one's route error channel:
a route that has not started cannot serve that, so doing it in `apply`
would drop the escalations it exists to deliver.

Config-only plugins have neither hook and are the common case. Say so in
their JSDoc (see [type-safety-and-schemas.md](./type-safety-and-schemas.md#plugin-vs-config-vs-store)
for when a plugin is the right shape at all).

`keepsAlive: true` declares that the plugin itself owns ongoing work. When all
routes complete, the context remains running until `stop()` is called instead of
auto-stopping. Use it only for a plugin that really owns a listener, subscription,
timer, or equivalent lifetime, and pair that lifetime with teardown. Omitting it
preserves route-driven auto-stop.

## 2. What `start()` may do

> A `start()` hook may perform bounded startup work; long work must page
> and log, and anything unbounded belongs in the plugin's own background
> task after `start()` returns.

`start()` is awaited, and the context is not ready until every hook has
resolved. That is what makes it useful: a test or an operator can rely on
a ready context having finished its startup work. It is also what makes an
unbounded hook a defect, because it stops the context coming up at all.

Bounded means the work has an end the plugin can name. A scan of overdue
records is bounded; it pages so its memory stays flat, and it logs
progress between pages so a large backlog reads as progress rather than a
hang. A poll loop, a subscription, or a retry-until-available is not
bounded: begin it in `start()` and return, leaving the plugin's own timer
or task to carry it.

## 3. Ordering and failure

- Plugins start in registration order, and each hook is awaited before the
  next plugin starts. A plugin whose work depends on an earlier plugin's
  runtime has the same guarantee at `start` that it already has at `apply`.
- A throwing `start()` fails `context.start()` with the original error,
  unwrapped. A context that could not start must never report itself as
  running.
- The unwind is the ordinary shutdown path, so EVERY applied plugin is
  torn down in reverse order, not only those whose `start()` ran. A
  `teardown()` therefore reads `info.started` rather than assuming its own
  `start()` happened. Without the unwind, a plugin that started an interval
  keeps the process alive after a boot that failed.
- A teardown that throws during the unwind is logged and does not replace
  the start error. The operator needs the cause of the failed boot, not
  whatever the cleanup hit on the way out.
- A `stop()` that arrives while a lifecycle hook is still awaiting WAITS
  for that hook before teardown runs, so the order a plugin observes is
  always `apply`/`start` entered, settled, then `teardown`. The wait covers
  the lifecycle hooks alone and never `run()`, which for an indefinite route
  resolves only at shutdown. It is unbounded for the same reason teardown
  is: a hook cut short keeps whatever it acquired past its last await point,
  and interrupting instead would oblige every plugin author to write
  `start()` so it tolerates teardown-before-completion. A hook that never
  settles is a defective plugin, not a shutdown-policy question.
- No hook runs once teardown has walked the applied set. Both walks re-check
  per plugin, so a `stop()` mid-boot stops the walk rather than applying or
  starting plugins nothing will release.

### The build-failure unwind

A failure inside `build()` has the same hole with none of the same escape
hatches: `build()` returns no context when it throws, so whatever an
earlier `apply()` acquired is unreachable and the caller never had a handle
to release it with. Under a supervisor that retries boot, that leaks one
resource per attempt; a held SQLite handle also keeps the file locked, so a
transient failure becomes a permanent one whose error names lock contention
instead of the real cause.

So `build()` unwinds too, on a failure in `initPlugins()` OR in
`registerRoutes()`, through the same reverse-order, failure-tolerant walk,
and rethrows the original error unchanged. Only plugins whose `apply()`
RETURNED are torn down: a build that failed at plugin 3 must not ask plugin
4 to release what it never acquired.

### What a teardown may assume

`teardown` receives a second argument saying how far the context got, so a
plugin never infers it from its own state:

| Field | Means |
|-------|-------|
| `partial` | This is not a fully started context: it never started (a build that failed partway, or an embedder that built and stopped without calling `start()`) or a `start()` hook threw. Routes may not be registered and later plugins may never have applied. |
| `started` | THIS plugin's own `start()` returned. Always false for a plugin with no `start()` hook, and false throughout a build-failure unwind. |

A plugin that only closes what `apply()` opened can ignore both and is
correct on every path. A plugin that stops what `start()` began reads
`started` rather than guarding on its own bookkeeping, which is what keeps
the distinction in the contract instead of in each plugin's defensive
coding.

`partial` is true for BOTH failure paths, not only the build one. A start
failure leaves a context that never came up just as a build failure does,
and one flag meaning two different things depending on which failure you
hit is exactly the ambiguity the argument exists to remove.

A plugin instance may serve more than one context in a process, so any
per-run state a hook creates is keyed by the `ctx` it was given, never held
in a closure slot. `suspensionPlugin` keys its sweeper in a `WeakMap` for
exactly this reason.

## 4. Readiness

`context.start()` does not resolve when the context comes up. It resolves
when the context stops, because an indefinite route (an HTTP server, a
`direct()` endpoint) keeps running. Anything that needs to know the
context is ready awaits `ctx.whenStarted()`, which resolves once no route
is still coming up and every `start()` hook has finished, and rejects with
the original error if a hook or the config refuses. A single route that
fails to come up is not observable there, because `start()` keeps the
remaining routes running by design; a probe that must know one specific
route is serving watches `route:started` for it. The wait on route
readiness is bounded (30 seconds): a `Source` adapter that never calls
`ready()` and never emits delays the plugin phase by that bound rather than
holding the context down forever. Everything `.from()` normalizes for you
signals readiness on its own, so the bound is a guard against a
misbehaving adapter rather than something a healthy boot approaches.

A context is single-use. `start()` after `stop()` refuses with `RC1004`,
because route controllers are built once and a restart would report ready
over dead routes; concurrent `start()` calls join one boot. The process is
the restart unit.

`@routecraft/testing`'s `startAndWaitReady()` and `test()` await it, so a
test asserting on work a `start()` hook does is not racing it.

## 5. Existing plugins

`mcpPlugin` prepares and mounts its HTTP handler in `apply()`, where
`requireWebIngress()` fails fast on a missing or undeclared server; its HTTP
`start()` hook does not wait for the named listener, so plugin registration
order cannot deadlock the sequential start hooks. The named-server plugin
validates every mount before binding and declares `keepsAlive` because the
listener outlives finite routes.

## References

- `packages/routecraft/src/context.ts` -- `CraftPlugin`, `startPlugins()`, `whenStarted()`
- `packages/routecraft/src/suspension/config.ts` -- all three phases on one plugin
- `packages/routecraft/test/plugin-start-hook.bun.test.ts` -- ordering and failure contract
- [type-safety-and-schemas.md](./type-safety-and-schemas.md#plugin-vs-config-vs-store) -- plugin vs config vs store
