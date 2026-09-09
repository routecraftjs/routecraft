---
"@routecraft/routecraft": patch
"@routecraft/ai": patch
"@routecraft/testing": patch
---

Retention counts from settlement, not from the deferral (#634).

`purgeSettled` measures the retention window from settlement rather than from the deferral, so a record that waits 89 days and settles on day 89 gets the full configured window from the moment it settled rather than being purged the next day. The timestamp is `outcome.at`, stamped by whichever transition settled the record (resumed, expired, denied), and a settled record the store cannot date is skipped rather than purged on a fallback clock.

`parseDuration(value, field)` is now exported from `@routecraft/routecraft`, so code that computes a ttl can validate it under exactly the rules the defer surfaces apply. `ctx.defer({ ttl })` (and its `testFn` twin) now validate the ttl at the call site with `RC5003`, matching `.defer()`, instead of surfacing a malformed duration after the handler has unwound.
