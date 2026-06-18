---
"@routecraft/routecraft": minor
---

Add the `concurrency` (bulkhead) wrapper operation.

`.concurrency({ max })` bounds how many exchanges run an operation at once, the sibling of `.throttle()` (which bounds a rate). Dual-mode like the other resilience wrappers: step scope wraps the next step, route scope (before `.from()`) bounds the whole pipeline at the innermost resilience position (inside `.retry()` / `.timeout()`, so a slot is held per attempt and freed between retry backoffs). The default `queue` mode applies backpressure (bounded by `maxQueue`); `mode: "reject"` fails fast with the new `RC5026` (retryable). A `key` selector partitions the pool per user / tenant / pool (bounded by `maxKeys`). Emits `route:concurrency:queued` / `:acquired` / `:released` / `:rejected`.
