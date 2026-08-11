# Plugin Lifecycle

A `CraftPlugin` has three phases. Each one runs at a different point in
the context's life, and which one a piece of work belongs in is decided
by what has to already exist for that work to be correct.

| Phase | Runs | The routes are | Use it for |
|-------|------|----------------|------------|
| `apply(ctx)` | While the context is being built, before any route starts | Registered, not running | Resolving config, opening resources, populating the context store |
| `start(ctx)` | After every route has started | Running | Work that drives routes or depends on them being able to serve |
| `teardown(ctx)` | During shutdown | Stopping or stopped | Releasing what `apply` opened and stopping what `start` began |

---

## 1. Which phase

The dividing line between `apply` and `start` is whether the work needs a
route to be able to run. Resolving a store handle does not; re-entering a
route's error channel does.

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
- Plugins that already started are torn down before the error surfaces,
  in the usual reverse order. Without that, a plugin that started an
  interval keeps the process alive after a boot that failed.
- A teardown that throws during the unwind is logged and does not replace
  the start error. The operator needs the cause of the failed boot, not
  whatever the cleanup hit on the way out.

A plugin instance may serve more than one context in a process, so any
per-run state a hook creates is keyed by the `ctx` it was given, never held
in a closure slot. `suspensionPlugin` keys its sweeper in a `WeakMap` for
exactly this reason.

Unwinding plugins that were **applied but never started**, when the
failure happens during the build, is out of scope here and tracked in
[#565](https://github.com/routecraftjs/routecraft/issues/565). That issue
extends this section rather than replacing it.

## 4. Readiness

`context.start()` does not resolve when the context comes up. It resolves
when the context stops, because an indefinite route (an HTTP server, a
`direct()` endpoint) keeps running. Anything that needs to know the
context is ready awaits `ctx.whenStarted()`, which resolves once no route
is still coming up and every `start()` hook has finished, and rejects with
the original error if a hook or the config refuses. A single route that
fails to come up is not observable there, because `start()` keeps the
remaining routes running by design; a probe that must know one specific
route is serving watches `route:started` for it.

`@routecraft/testing`'s `startAndWaitReady()` and `test()` await it, so a
test asserting on work a `start()` hook does is not racing it.

## 5. Existing plugins

`mcpPlugin` starts its server inside `apply()`, which predates this hook.
New work goes in `start()`; moving existing plugins is a behaviour change
and is done deliberately, not as drive-by cleanup.

## References

- `packages/routecraft/src/context.ts` -- `CraftPlugin`, `startPlugins()`, `whenStarted()`
- `packages/routecraft/src/suspension/config.ts` -- all three phases on one plugin
- `packages/routecraft/test/plugin-start-hook.bun.test.ts` -- ordering and failure contract
- [type-safety-and-schemas.md](./type-safety-and-schemas.md#plugin-vs-config-vs-store) -- plugin vs config vs store
