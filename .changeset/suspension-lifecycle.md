---
"@routecraft/routecraft": minor
---

Suspensions expire, heal their own delivery, and get retired on a schedule; plugins get a `start()` phase; contexts are single-use (#551).

A `ttl` used to be enforced only when a late answer arrived. Nobody presents a token for a suspension that timed out, so an unanswered one sat in the store past its deadline and its route was never told: the "nobody approved in 72 hours, escalate" flow the deadline exists for did not run. A sweeper now retires overdue suspensions on a schedule, emitting `route:exchange:expired` and re-entering the route's error channel with `RC5047`, and scans at startup before the context reports ready so an outage's backlog reaches its routes ahead of new traffic.

**Suspensions now expire by default.** Omitting `ttl` previously meant no expiry at all; it now means the context's `defaultTtl`, which is `72h`. A deployment relying on parks that live indefinitely must set `suspension: { defaultTtl: 'never' }`.

**Expiry delivery is crash-safe, and at-least-once.** Retiring is claim (`suspended` -> the new `expiring` status) -> notify -> finalize (`expired` / `denied`). A process that dies mid-delivery leaves a claim the sweeper releases after `expiryLease` (default `60m`) and redelivers, so the approver hears about the expiry despite the crash; a crash after notifying but before finalizing redelivers one duplicate escalation. A token presented while a record is `expiring` reads as expired (`RC5047`), and a released record is past its deadline, so a late answer is refused either way.

**Settled records are now purged.** `retention` (default `90d`, `"never"` to keep everything) drives `purgeSettled` once at boot and hourly after. Previously nothing ever removed a settled record, so a long-running process accumulated every exchange that ever suspended.

**The sweep pages on a keyset cursor** ordered `(expiresAt, id)`, advancing past every visited record, so records a context cannot retire (a renamed route's parked suspensions, a shared store) can never starve the work behind them, whatever their number.

**Breaking for out-of-tree stores.** `SuspensionStore` changes shape: `findExpired(now, limit, after?)` takes a required limit and an optional keyset cursor and must order by `(expiresAt, id)`; new required members `claimExpiry(id, at)` and `releaseExpiring(before)`; `markExpired` / `markDenied` now finalize from `expiring` rather than transitioning from `suspended`; `resumedWithoutTerminal(limit?)` is required and diagnostic-only; `SuspensionStatus` gains `"expiring"` and records gain `claimedAt`. The shipped sqlite backend migrates its schema automatically on open (version 2: `claimed_at` column, `(status, expires_at, id)` sweep index).

**Breaking: `plugin:started` changes meaning.** The `apply()` phase events are renamed `plugin:applying` / `plugin:applied`, and the new `start()` lifecycle phase takes the plain names `plugin:starting` / `plugin:started`, so the event vocabulary matches the lifecycle (applying, starting, stopping). `plugin:started` does not disappear: an existing subscriber keeps compiling and keeps firing, but it now marks start-done instead of apply-done and fires later than it did, after every route is up.

**Breaking: a context is single-use.** `context.start()` after `context.stop()` now refuses with `RC1004` instead of resolving readiness over routes whose controllers are gone. Build a fresh context from your config; the process is the real restart unit, and `craft run` already behaves this way. Two concurrent `start()` calls now collapse into one boot instead of running every plugin `start()` hook twice.

**New: `CraftPlugin.start?(ctx)`**, a third lifecycle phase between `apply` and `teardown`, running after every route has signalled readiness (bounded by a 30s backstop for sources that never signal). Hooks run in registration order, each awaited; a throwing hook fails `context.start()` with the original error after tearing the context down. `CraftContext.whenStarted()` resolves once no route is still coming up and every hook has finished, which is what `startAndWaitReady()` in `@routecraft/testing` awaits. A single route failing to come up is deliberately not observable there; watch `route:started` for per-route readiness.

Also fixed: a transient store error while caching a completed continuation's outcome no longer reports the finished work as failed to the answerer, and `defaultTtl` was ignored on the sqlite backend, which is the production default.
