---
"@routecraft/routecraft": minor
---

Add the `sample` and `dedupe` flow-control operations.

`sample({ every })` passes every Nth exchange and `sample({ intervalMs })` passes the first exchange in each time window, dropping the rest (silently, like a `filter` returning false). `dedupe(options?)` suppresses duplicate exchanges by a derived key with reserve-on-entry / commit-on-completion / release-on-failure semantics, an optional `key` function, and `ttl` / `maxKeys` bounds on the per-route in-memory key set. Both emit `route:operation:<op>:*` events. The default key derivation (SHA-256 of the body's JSON serialisation) is shared with `cache` via the new `hashExchangeBody` utility.
