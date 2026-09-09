---
"@routecraft/routecraft": minor
---

Deferrals expire, heal their own delivery, and get retired on a schedule; plugins get a `start()` phase; contexts are single-use (#551).

A `ttl` used to be enforced only when a late answer arrived. Nobody presents a token for a deferral that timed out, so an unanswered one sat in the store past its deadline and its route was never told: the "nobody approved in 72 hours, escalate" flow the deadline exists for did not run. A sweeper now retires overdue deferrals on a schedule, emitting `route:exchange:expired` and re-entering the route's error channel with `RC5047`, and scans at startup before the context reports ready so an outage's backlog reaches its routes ahead of new traffic.

**Deferrals now expire by default.** Omitting `ttl` previously meant no expiry at all; it now means the context's `defaultTtl`, which is `72h`. A deployment relying on deferrals that live indefinitely must set `deferral: { defaultTtl: 'never' }`.

**Expiry delivery is crash-safe, and at-least-once.** Retiring is claim -> notify -> settle (`expired` / `denied`). The claim is `claimedAt` on a record that is still `waiting`, so it is not an outcome: a process that dies mid-delivery leaves a claim the sweeper releases after `expiryLease` (default `60m`) and redelivers, so the approver hears about the expiry despite the crash; a crash after notifying but before settling redelivers one duplicate escalation. The two claim kinds replay differently, because only one of them is taken past a deadline. A token presented under an expiry claim reads as expired (`RC5047`) and a released expiry claim is past its deadline, so a late answer is refused either way. A token presented under a denial claim reads as denied (`RC5050`), and releasing that claim leaves the record resumable again until something settles it, since a denial says nothing about the deadline.

**Settled records are now purged.** `retention` (default `90d`, `"never"` to keep everything) drives `purgeSettled` once at boot and hourly after. Previously nothing ever removed a settled record, so a long-running process accumulated every exchange that ever deferred.

**The sweep pages on a keyset cursor** ordered `(expiresAt, id)`, advancing past every visited record, so records a context cannot retire (a renamed route's deferrals, a shared store) can never starve the work behind them, whatever their number.

**What an out-of-tree store implements.** `findExpired(now, limit, after?)` takes a required limit and an optional keyset cursor and must order by `(expiresAt, id)`; `claimExpiry(id, at)` takes the delivery claim and `releaseClaims(before)` releases stale ones; `markExpired` / `markDenied` settle a claimed record rather than a merely waiting one; `resumedWithoutContinuation(limit?)` is diagnostic-only. A record is resumable while it is `waiting` with no `claimedAt`, which the exported `resumable(record)` predicate answers, and the shipped sqlite backend spells the same compare as its `WHERE` clause.

**Breaking: `plugin:started` changes meaning.** The `apply()` phase events are renamed `plugin:applying` / `plugin:applied`, and the new `start()` lifecycle phase takes the plain names `plugin:starting` / `plugin:started`, so the event vocabulary matches the lifecycle (applying, starting, stopping). `plugin:started` does not disappear: an existing subscriber keeps compiling and keeps firing, but it now marks start-done instead of apply-done and fires later than it did, after every route is up.

**Breaking: a context is single-use.** `context.start()` after `context.stop()` now refuses with `RC1004` instead of resolving readiness over routes whose controllers are gone. Build a fresh context from your config; the process is the real restart unit, and `craft run` already behaves this way. Two concurrent `start()` calls now collapse into one boot instead of running every plugin `start()` hook twice.

**New: `CraftPlugin.start?(ctx)`**, a third lifecycle phase between `apply` and `teardown`, running after every route has signalled readiness (bounded by a 30s backstop for sources that never signal). Hooks run in registration order, each awaited; a throwing hook fails `context.start()` with the original error after tearing the context down. `CraftContext.whenStarted()` resolves once no route is still coming up and every hook has finished, which is what `startAndWaitReady()` in `@routecraft/testing` awaits. A single route failing to come up is deliberately not observable there; watch `route:started` for per-route readiness.

Also fixed: a transient store error while caching a completed continuation's result no longer reports the finished work as failed to the caller, and `defaultTtl` was ignored on the sqlite backend, which is the production default.
