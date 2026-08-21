---
"@routecraft/routecraft": patch
"@routecraft/ai": patch
"@routecraft/testing": patch
---

Retention counts from settlement, not from the park (#634).

`purgeSettled` used to measure the retention window from `suspendedAt` because the store carried no settlement timestamp, so a record that parked for 89 days and resolved on day 89 was purged one day after settling. Records now carry `settledAt`, stamped on every terminal transition (resumed, expired, denied), and retention measures from it: a settled record gets the full configured window from the moment it settled, however long it was parked before that.

**The SQLite store migrates itself to schema v4.** Existing settled rows are backfilled best-effort from the evidence each status carries: `resumed_at` exactly, `expires_at` for expired rows, and the `suspended_at` approximation for denied rows. Backfilled rows may therefore live somewhat longer than they would have under the old clock, never shorter than the new contract promises.

`parseDuration(value, field)` is now exported from `@routecraft/routecraft`, so code that computes a ttl can validate it under exactly the rules the suspend surfaces apply. `ctx.suspend({ ttl })` (and its `testFn` twin) now validate the ttl at the call site with `RC5003`, matching `.suspend()`, instead of surfacing a malformed duration after the handler has unwound.
