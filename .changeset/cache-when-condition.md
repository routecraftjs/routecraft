---
"@routecraft/routecraft": minor
---

`.cache({ when })`: a per-exchange condition beside `key`.

`when` runs before the key is derived, at route scope and at step scope alike. When it returns `false` the exchange skips both the read and the write, emits `route:cache:bypassed` in place of a hit or a miss, and runs as if no cache were declared. It is for the cases a key cannot express: an operation that is only sometimes safe to cache (a lookup, but not with `force: true`; the read-only tools of a proxied remote server, but not the writing ones under the same route), or a caller who must always see a fresh answer. `when` decides synchronously, from what the exchange already carries; the header a source sets as `HeadersKeys.CACHE_DISCRIMINATOR` (`routecraft.cache.discriminator`) is folded into the default key for a source that delivers several operations into one route. A `when` that throws, or returns a promise, fails the exchange with the new `RC5069` and reports `phase: "when"` on `route:cache:failed`.
