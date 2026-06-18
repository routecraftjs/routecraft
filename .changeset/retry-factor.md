---
"@routecraft/routecraft": major
---

Harden `.retry()` backoff and remove the `exponential` option (breaking).

`retry({ exponential })` is removed in favour of `factor`, a numeric growth multiplier: the wait before attempt `n` is `backoffMs * factor^(n - 1)`. Migrate `exponential: true` to `factor: 2` and `exponential: false` (or omitted) to `factor: 1` (the new default, fixed backoff). Passing `exponential` now throws `RC5003` at build with a migration hint. Two new options ship alongside: `maxBackoffMs` caps a single wait so a steep `factor` cannot grow unbounded, and `jitter` (`"none"` | `"full"` | a `0..1` fraction) randomises each wait to de-sync retry storms (it only ever shortens a wait, so the cap still holds).
