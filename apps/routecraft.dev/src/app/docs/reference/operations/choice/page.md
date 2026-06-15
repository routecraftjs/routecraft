---
title: choice
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
choice<Out = Current>(
  ...descriptors: ChoiceDescriptor<Current, Out>[]
): RouteBuilder<Out>
```

Conditionally route exchanges through one of several branches. Branches are passed variadically as `when(...)` / `otherwise(...)` descriptors built from the standalone helpers, the same path surface shared with `multicast`. Predicates are evaluated in registration order; the first match wins. The optional `otherwise` branch catches exchanges that no `when` matched; if omitted and no branch matches, the exchange is dropped with `reason: "unmatched"`.

Matched branches inline their steps before the remaining main-pipeline steps, so the exchange converges back into the main flow after the choice. A branch that ends in `b.halt()` short-circuits: the exchange is dropped with `reason: "halted"` and the main pipeline does not resume for it.

```ts
import { when, otherwise } from "@routecraft/routecraft";

.from(incomingOrders)
.choice(
  when(
    (ex) => ex.body.priority === "urgent",
    (b) => b.transform(prioritize).to(urgentQueue),
  ),
  when(
    (ex) => ex.body.amount > 1000,
    (b) => b.to(reviewQueue),
  ),
  otherwise((b) => b.to(errorSink).halt()),
)
.to(audit); // runs for urgent and review; skipped for otherwise (halted)
```

Each branch is a path: either a bare destination or a sub-pipeline callback `(b) => b...`. Sub-pipeline branches support the full set of pipeline operations available on the main route: `to()`, `transform()`, `enrich()`, `filter()`, `header()`, `tap()`, `process()`, `validate()`, plus the sugar methods `log()`, `debug()`, `map()`, and `schema()`. The only path-specific op is `halt()`, which short-circuits convergence. Route-level operations (`id`, `batch`, `error`, `from`, `split`, `aggregate`, `choice`, `build`) are deliberately not exposed inside branches because they either configure the route itself or fan out in ways that break the "branch converges" model.

Branches that change body type via `transform()` / `process()` / `validate()` / `map()` / `schema()` / `enrich()` must converge on the same `Out` type; the descriptor return types enforce this at compile time.

> When `when(...)` is passed directly to `.choice(...)`, the predicate body type is inferred from the route's current body, so `ex.body` is typed without an annotation. You only need to annotate the predicate or supply the type argument (`when<Order>(...)`) when building a descriptor outside the call (assigned to a variable first), where there is no context to infer from.

**Events:**

- `route:operation:choice:matched` -- `{ routeId, exchangeId, correlationId, branchIndex, branchLabel: "when" | "otherwise" }`
- `route:operation:choice:unmatched` -- `{ routeId, exchangeId, correlationId }`, fires when no branch matched and the exchange is dropped.

**Known limitations:**

- Nested `.choice()` inside a branch is not supported (the path builder does not expose `choice`).
- Predicates must be synchronous.
- `otherwise()` may only be passed once per choice (throws otherwise).
