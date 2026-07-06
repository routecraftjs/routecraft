---
title: dispatch
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
dispatch(strategy, ...targets): RouteBuilder<Current>
```

Run **exactly one** of several targets, chosen by a load-balancing strategy. The sibling of `multicast` (all targets) and `choice` (one target by predicate); dispatch is one target by strategy. A target is a bare destination, a sub-pipeline callback `(b) => b...` (the same path surface as `multicast`), or either wrapped in `weighted(...)` to co-locate a relative weight.

```ts
.from(http("/jobs"))
.dispatch("round-robin", workerA, workerB, workerC)
.to(next); // runs on the original exchange after the selected target settles
```

The leading strategy argument is **required**: there is no safe default, because each strategy makes a materially different routing decision.

## Strategies

- **`failover`** -- try targets in order until one succeeds. A target that deliberately drops the exchange counts as handled; only a genuine failure fails over. The preferred-target cursor persists across exchanges, so a healthy target keeps serving and a dead one is not re-probed every exchange (it does not auto-revert to a recovered earlier target until the current one fails). Pairs naturally with per-target `.retry()` / `.circuitBreaker()`.
- **`round-robin`** -- hand out targets in order, cycling.
- **`weighted`** -- distribute by the `weighted()` weights using smooth weighted round-robin, so the distribution matches the weights and is deterministic rather than random. Un-weighted targets default to weight 1.
- **`sticky`** -- exchanges sharing a `key` go to the same target. New keys are round-robined across targets and remembered in an LRU-bounded affinity map. Object form only, because `key` is required.

```ts
// Failover: primary, then secondary if it fails.
.dispatch("failover", primary, secondary)

// Weighted canary: ~95% to stable, ~5% to canary.
.dispatch("weighted", weighted(stable, 95), weighted(canary, 5))

// Sticky sessions: one user's traffic always lands on one worker.
.dispatch({ strategy: "sticky", key: (ex) => ex.body.userId }, workerA, workerB)
```

## Semantics

- **Side-effect-only.** The selected target runs on its own deep clone (fresh id, preserved correlation id) and the ORIGINAL exchange continues downstream unchanged, so the body type is preserved and a target's output is unconstrained. Dispatch waits for the selected target to settle before the original continues.
- **Error isolation.** A target that throws fires its own clone's error events (`route:error` / `route:exchange:failed`) but does not fail the route or the dispatch step. For `failover`, a failure advances to the next target; if every target fails, `route:operation:dispatch:exhausted` fires and the original still continues.
- **Per-route state.** The round-robin cursor, the failover cursor, the weighted running weights, and the sticky affinity map are kept per route, so distinct contexts running the same route definition never cross-route each other's traffic.

A bare destination must be an object destination (`{ send }`); a callable destination (a bare function with a `send` method) is indistinguishable from a sub-pipeline callback at runtime, so wrap it as `(b) => b.to(callableDest)`.

The `sticky` affinity map is bounded by `maxKeys` (default 10,000). When the cap is reached the least-recently-seen key is evicted and its next occurrence is reassigned (possibly to a different target):

```ts
.dispatch({ strategy: "sticky", key: (ex) => ex.body.userId, maxKeys: 50_000 }, a, b)
```

## Events

- `route:operation:dispatch:selected` -- `{ routeId, exchangeId, correlationId, strategy, targetIndex }`, fired when a target is chosen to run. For `failover`, fired once per attempt.
- `route:operation:dispatch:exhausted` -- `{ routeId, exchangeId, correlationId, strategy: "failover", targetCount }`, fired when `failover` runs out of targets and none handled the exchange.
