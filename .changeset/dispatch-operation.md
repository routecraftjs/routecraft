---
"@routecraft/routecraft": minor
---

Add the `dispatch` flow-control operation.

`.dispatch(strategy, ...targets)` runs exactly one of several targets, chosen by a load-balancing strategy, the sibling of `multicast` (all targets) and `choice` (one by predicate). The required leading strategy is `"failover"` (try targets in order until one succeeds; pairs with per-target `.retry()` / `.circuitBreaker()`), `"round-robin"`, `"weighted"` (smooth weighted round-robin over the new `weighted(target, n)` helper, which co-locates a relative weight with its target), or `{ strategy: "sticky", key, maxKeys? }` (exchanges sharing a key stick to one target, via an LRU-bounded affinity map). Side-effect-only like `multicast`: the selected target runs on its own clone and the original continues unchanged; a target failure stays isolated to its clone's error events, and an exhausted `failover` chain emits `route:operation:dispatch:exhausted`. Emits `route:operation:dispatch:selected` / `:exhausted`. The executor's step context gains a `runPath` capability (a single isolated nested run that reports its outcome) so `failover` can advance on a failed target.
