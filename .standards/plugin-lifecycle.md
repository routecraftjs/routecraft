# Plugin Lifecycle

A plugin (`definePlugin({ id, bind?, start?, stop? })`) has three hooks. Each
runs at a different point in the application's life, and which one a piece of
work belongs in is decided by what has to already exist for that work to be
correct. [plugin-architecture.md](./plugin-architecture.md) owns the descriptor,
ports and faults; this page owns the phases.

| Hook | Runs | The routes are | Use it for |
|------|------|----------------|------------|
| `bind(c)` | While the application is installed, in dependency order, before any route is registered | Not registered yet | Requiring and providing ports, resolving config, opening resources, observing events |
| `start(c)` | After every route has started | Running | Work that drives routes or depends on them being able to serve |
| `stop(c, info)` | During shutdown, or when an install or start failed partway | Stopping, stopped, or never started | Releasing what `bind` opened and stopping what `start` began |

Between `bind` and `start` the kernel does two things a plugin can rely on:
it **freezes** the application (a `provide`, a route registration or a hook
contribution after that is `RC1110`) and it **compiles** every route (a
position or a plugin step nobody provides is `RC1111`, and the application
does not start).

---

## 1. Which hook

The dividing line between `bind` and `start` is whether the work needs a
route to be able to run. Resolving a store does not; re-entering a route's
error channel does.

`initPlugins()` runs before `registerRoutes()`, so during `bind` the
builder's routes do not exist yet. A plugin that reads `c.routes.list()` in
`bind` sees only routes other plugins registered.

The deferral plugin is the worked example. `bind` resolves the store and the
token signer and provides `CONTINUATIONS`, so a missing signing secret fails
while the application is still being installed rather than after it has
accepted traffic. `start` runs the kernel's boot sweep through
`c.execution.sweep({ boot: true })`, which retires deferrals that came due
while the process was down and re-enters each one's route error channel: a
route that has not started cannot serve that, so doing it in `bind` would
drop the escalations it exists to deliver. `start` then arms the plugin's
own cadence, and `stop` waits for the pass in flight before the store closes.

Config-only plugins have no hooks and are the common case. Say so in their
JSDoc (see [type-safety-and-schemas.md](./type-safety-and-schemas.md#plugin-vs-config-vs-store)
for when a plugin is the right shape at all).

`keepsAlive: true` declares that the plugin itself owns ongoing work. When
every route completes, the application keeps running until stopped instead
of auto-stopping. Use it only for a plugin that really owns a listener,
subscription, timer, or equivalent lifetime, and pair that lifetime with
`stop`. Omitting it preserves route-driven auto-stop.

## 2. What `start()` may do

> A `start()` hook may perform bounded startup work; long work must page
> and log, and anything unbounded belongs in the plugin's own background
> task after `start()` returns.

`start()` is awaited, and the application is not ready until every hook has
resolved. That is what makes it useful: a test or an operator can rely on a
ready application having finished its startup work. It is also what makes an
unbounded hook a defect, because it stops the application coming up at all.

Bounded means the work has an end the plugin can name. A scan of overdue
records is bounded; it pages so its memory stays flat, and it logs progress
between pages so a large backlog reads as progress rather than a hang. A poll
loop, a subscription, or a retry-until-available is not bounded: begin it in
`start()` and return, leaving the plugin's own timer or task to carry it.

## 3. Ordering and failure

- Plugins bind and start in **dependency order**: a plugin that requires a
  port binds after the plugin that provides it, a repeatable plugin binds
  ahead of every other consumer of the ports it uses, and ties keep list
  order.
  Default plugins come first, so the application's own plugins keep their
  relative order. Each hook is awaited before the next plugin's runs. A
  cycle is `RC1107` and nothing binds.
- A plugin that depends on another plugin's `start()` (not only on its
  `bind()`) declares the edge: list that plugin's port in `requires` or
  `optional`. Nothing else orders starts.
- A throwing `start()` fails `context.start()` with the original error,
  unwrapped. An application that could not start must never report itself
  as running.
- The unwind is the ordinary shutdown path, so EVERY bound plugin is
  stopped in reverse dependency order, not only those whose `start()` ran.
  After a plugin's own `stop`, the disposers it registered with
  `c.onDispose()` run LIFO, every one even when another throws. A `stop()`
  therefore reads `info.started` rather than assuming its own `start()`
  happened. Without the unwind, a plugin that started an interval keeps the
  process alive after a boot that failed.
- A `stop` or disposer that throws during the unwind is logged and does not
  replace the start error. The operator needs the cause of the failed boot,
  not whatever the cleanup hit on the way out.
- A shutdown that arrives while a lifecycle hook is still awaiting WAITS for
  that hook before the stop walk runs, so the order a plugin observes is
  always `bind`/`start` entered, settled, then `stop`. The wait covers the
  lifecycle hooks alone and never `run()`, which for an indefinite route
  resolves only at shutdown. It is unbounded for the same reason `stop` is:
  a hook cut short keeps whatever it acquired past its last await point, and
  interrupting instead would oblige every plugin author to write `start()`
  so it tolerates stop-before-completion. A hook that never settles is a
  defective plugin, not a shutdown-policy question.
- No hook runs once the stop walk has begun. Both walks re-check per
  plugin, so a stop mid-boot stops the walk rather than binding or starting
  plugins nothing will release.

### A hook must not wait for its own shutdown

A lifecycle hook may shut the application down. What it must not do is
**wait** for that shutdown from inside the hook: the hook then waits for a
shutdown that is waiting for the hook, and neither ever settles. A plugin
never holds the context, so the only spelling it has is the one that cannot
make this mistake:

| Intent | Spelling | What happens |
|--------|----------|--------------|
| Abort the boot with a reason | `throw` | the install or start unwinds through the stop walk and the error reaches the operator unchanged |
| Request shutdown without failing the boot | `c.execution.requestStop()` | returns at once; the hook settles, the wait sees it settle, and the stop walk follows in its proper order |

```ts
async start(c) {
  if (!healthy) throw rcError("RC9901", undefined, { message: "..." });
  // or, to stand the application down without failing the boot:
  c.execution.requestStop();
}
```

### The install-failure unwind

A failure while the application is installed has the same hole with none of
the same escape hatches: `build()` returns no context when it throws, so
whatever an earlier `bind()` acquired is unreachable and the caller never
had a handle to release it with. Under a supervisor that retries boot, that
leaks one resource per attempt; a held SQLite handle also keeps the file
locked, so a transient failure becomes a permanent one whose error names
lock contention instead of the real cause.

So the install unwinds too, on a failure in a `bind()` OR in
`registerRoutes()`, through the same reverse-order, failure-tolerant walk,
and rethrows the original error unchanged. Only plugins whose `bind()`
RETURNED are stopped: an install that failed at plugin 3 must not ask plugin
4 to release what it never acquired. The plugin whose `bind()` threw still
has its disposers run: `onDispose` and `observe` register per acquisition,
precisely so a bind that fails partway releases what it got. A plugin that
acquires in `bind` registers each release with `c.onDispose` right after
acquiring, and then needs no `stop` for it.

A start refused before any route runs (a missing provider, `RC1111`, or an
unconfigured `.defer()`, `RC5052`) takes the same walk: `build()` succeeded,
so the plugins hold their resources, and the caller of a failed start has no
reason to call `stop()` itself. Host faults (`RC1101` to `RC1109`) are
raised before any plugin binds, so nothing needs releasing at all.

### What `stop` may assume

`stop` receives a second argument saying how far the application got, so a
plugin never infers it from its own state:

| Field | Means |
|-------|-------|
| `partial` | This is not a fully started application: it never started (an install that failed partway, or an embedder that built and stopped without calling `start()`) or a `start()` hook threw. Routes may not be registered and later plugins may never have bound. |
| `started` | THIS plugin's own `start()` returned. Always false for a plugin with no `start()` hook, and false throughout an install-failure unwind. |

A plugin that only closes what `bind()` opened can ignore both and is correct
on every path. A plugin that stops what `start()` began reads `started`
rather than guarding on its own bookkeeping, which is what keeps the
distinction in the contract instead of in each plugin's defensive coding.

`partial` is true for BOTH failure paths, not only the install one. A start
failure leaves an application that never came up just as an install failure
does, and one flag meaning two different things depending on which failure
you hit is exactly the ambiguity the argument exists to remove.

A plugin descriptor may serve more than one application in a process, so
any per-run state a hook creates is keyed by the `PluginContext` it was
given, never held in a closure slot. `deferralPlugin` keys its runtime and
cadence in a `WeakMap<PluginContext, ...>` for exactly this reason.

## 4. Readiness

`context.start()` does not resolve when the application comes up. It
resolves when the application stops, because an indefinite route (an HTTP
server, a `direct()` endpoint) keeps running. Anything that needs to know
the application is ready awaits `ctx.whenStarted()`, or
`c.execution.whenStarted()` from a plugin, which resolves once no route is
still coming up and every `start()` hook has finished, and rejects with the
original error if a hook or the config refuses. A single route that fails to
come up is not observable there, because `start()` keeps the remaining
routes running by design; a probe that must know one specific route is
serving watches `route:started` for it. The wait on route readiness is
bounded (30 seconds): a `Source` adapter that never calls `ready()` and never
emits delays the plugin phase by that bound rather than holding the
application down forever. Everything `.from()` normalizes for you signals
readiness on its own, so the bound is a guard against a misbehaving adapter
rather than something a healthy boot approaches.

A context is single-use. `start()` after `stop()` refuses with `RC1004`,
because route controllers are built once and a restart would report ready
over dead routes; concurrent `start()` calls join one boot. The process is
the restart unit.

`@routecraft/testing`'s `startAndWaitReady()` and `test()` await it, so a
test asserting on work a `start()` hook does is not racing it.

## 5. Existing plugins

`mcpPlugin` prepares and mounts its HTTP handler in `bind()`, where
`requireWebIngress()` fails fast on a missing or undeclared server; its HTTP
`start()` hook does not wait for the named listener, so plugin order cannot
deadlock the sequential start hooks. The servers plugin validates every
mount before binding and declares `keepsAlive` because the listener outlives
finite routes.

## References

- `packages/routecraft/src/kernel/host.ts` -- install, identity, resolution, dependency order, freeze
- `packages/routecraft/src/context.ts` -- `initPlugins()`, `startPlugins()`, `teardownPlugins()`, `whenStarted()`
- `packages/routecraft/src/plugins/deferral/index.ts` -- all three hooks on one plugin
- `packages/routecraft/test/plugin-start-hook.bun.test.ts` -- ordering and failure contract
- `packages/routecraft/test/kernel-host.bun.test.ts` -- host faults and dependency order
- [type-safety-and-schemas.md](./type-safety-and-schemas.md#plugin-vs-config-vs-store) -- plugin vs config vs store
