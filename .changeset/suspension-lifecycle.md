---
"@routecraft/routecraft": minor
---

Suspensions expire on their own, and plugins get a `start()` phase (#551).

A `ttl` used to be enforced only when a late answer arrived. Nobody presents a token for a suspension that timed out, so an unanswered one sat in the store past its deadline and its route was never told: the "nobody approved in 72 hours, escalate" flow the deadline exists for did not run. A sweeper now retires overdue suspensions on a schedule, emitting `route:exchange:expired` and re-entering the route's error channel with `RC5047`.

**Suspensions now expire by default.** Omitting `ttl` previously meant no expiry at all; it now means the context's `defaultTtl`, which is `72h`. A deployment relying on parks that live indefinitely must set `suspension: { defaultTtl: 'never' }`, and then owns retiring them itself. The change is deliberate: a parked exchange nothing will ever retire holds its serialized body forever and never tells its route that nobody answered.

**Two new config fields.** `defaultTtl` (`Duration | "never"`, default `72h`) and `sweepInterval` (`Duration`, default `60s`). Expiry is honoured within one sweep interval of the deadline rather than on it.

**Startup scans before the context is ready.** Whatever came due while the process was down retires first, so an operator restarting after an outage gets those escalations ahead of new traffic. The same scan reports records left `resumed` with no terminal outcome, which is what a process dying mid-continuation leaves behind. That report is diagnostic: those approvals are spent and their side effects may have half applied, so nothing re-drives them automatically.

**The sweeper never decides an outcome twice.** It competes for the same compare-and-swap a late answer competes for, so an approval landing on the deadline is either accepted or expired, never both, and only the winner notifies.

**New: `CraftPlugin.start?(ctx)`**, a third lifecycle phase between `apply` and `teardown`, running after every route has started. Additive, and existing plugins are unaffected. Hooks run in registration order, each awaited before the next; a hook that throws fails `context.start()` with the original error after tearing down the plugins that did start. `CraftContext.whenStarted()` resolves once routes are up and every hook has finished, which is what `startAndWaitReady()` in `@routecraft/testing` now awaits.

**Two new events**, `plugin:start:starting` and `plugin:start:started`, bracketing the `start()` hook the way `plugin:starting` / `plugin:started` bracket `apply()`.

**`context.start()` now waits for routes to signal readiness before running plugin `start()` hooks**, and therefore before `whenStarted()` resolves. Previously it continued as soon as every route had entered `start()`, which for a source with an asynchronous subscribe (HTTP, mail, MCP) meant readiness could be reported before the port was bound.

**Breaking for out-of-tree stores (0.x, so `minor`): `SuspensionStore` gains a required `resumedWithoutTerminal(limit?)`.** Anyone who implemented the interface against a backend of their own must add it; it returns records stuck at `resumed` with no terminal outcome, oldest first. The shipped sqlite and in-memory backends implement it and the shared contract suite covers both.

Also fixed: `defaultTtl` was ignored on the sqlite backend, which is the production default.
