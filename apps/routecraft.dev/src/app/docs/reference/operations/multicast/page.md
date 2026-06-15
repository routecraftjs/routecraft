---
title: multicast
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
multicast(...paths: Path<Current>[]): RouteBuilder<Current>
```

Fan the exchange out to multiple independent paths in parallel. Each path is either a bare destination or a sub-pipeline callback `(b) => b...` (the same path surface as `choice`). Every path receives its own deep clone of the exchange (fresh id, preserved correlation id) and runs as an isolated nested pipeline.

```ts
.from(http("/orders"))
.multicast(
  queue("audit"), // bare destination
  (b) => b.transform(toWarehouse).to(http("/wh")), // sub-pipeline path
)
.to(next); // runs on the original exchange after all paths settle
```

**Semantics:**

- **Parallel-wait.** All paths run concurrently and the step waits for every one to settle, joined with `Promise.allSettled`. The original exchange continues downstream unchanged once every path has settled.
- **Error isolation.** A path that throws fires its own clone's error events (`route:error` / `context:error` / `route:exchange:failed`) but does not fail the route or its sibling paths.
- **Independent halt.** A path that ends in `b.halt()` only stops itself; the other paths and the original exchange are unaffected.
- **Deep copy.** Each path mutates an independent `structuredClone` of the body, so a path-side mutation can never race the original or a sibling.
- **No fire-and-forget.** Fire-and-forget is intentionally not offered here; use `tap` (already fire-and-forget) for that.

A bare path must be an object destination (`{ send }`); a callable destination (a bare function with a `send` method) is indistinguishable from a sub-pipeline callback at runtime, so wrap it as `(b) => b.to(callableDest)`.

**Events:**

- `route:<id>:operation:multicast:started` -- `{ pathCount }`, fired before the exchange is cloned to each path.
- `route:<id>:operation:multicast:stopped` -- `{ pathCount }`, fired once every path has settled and the original continues.
