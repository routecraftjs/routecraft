---
title: choice
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
choice<Out = Current>(
  fn: (c: ChoiceSubBuilder<Current, Out>) => ChoiceSubBuilder<Current, Out>,
): RouteBuilder<Out>
```

Conditionally route exchanges through one of several branches. Branches are defined via a callback sub-builder, so `when` and `otherwise` are only reachable inside a `choice` block. Predicates are evaluated in registration order; the first match wins. The optional `otherwise` branch catches exchanges that no `when` matched; if omitted and no branch matches, the exchange is dropped with `reason: "unmatched"`.

Matched branches inline their steps before the remaining main-pipeline steps, so the exchange converges back into the main flow after the choice. A branch that ends in `b.halt()` short-circuits: the exchange is dropped with `reason: "halted"` and the main pipeline does not resume for it.

```ts
.from(incomingOrders)
.choice((c) =>
  c
    .when(
      (ex) => ex.body.priority === "urgent",
      (b) => b.transform(prioritize).to(urgentQueue),
    )
    .when(
      (ex) => ex.body.amount > 1000,
      (b) => b.to(reviewQueue),
    )
    .otherwise((b) => b.to(errorSink).halt()),
)
.to(audit); // runs for urgent and review; skipped for otherwise (halted)
```

Branches support the full set of pipeline operations available on the main route: `to()`, `transform()`, `enrich()`, `filter()`, `header()`, `tap()`, `process()`, `validate()`, plus the sugar methods `log()`, `debug()`, `map()`, and `schema()`. The only branch-specific op is `halt()`, which short-circuits convergence. Route-level operations (`id`, `batch`, `error`, `from`, `split`, `aggregate`, `choice`, `build`) are deliberately not exposed inside branches because they either configure the route itself or fan out in ways that break the "branch converges" model.

Branches that change body type via `transform()` / `process()` / `validate()` / `map()` / `schema()` / `enrich()` must converge on the same `Out` type; the callback return type enforces this at compile time.

**Events:**

- `route:<id>:operation:choice:matched` -- `{ branchIndex, branchLabel: "when" | "otherwise" }`
- `route:<id>:operation:choice:unmatched` -- fires when no branch matched and the exchange is dropped.

**Known limitations:**

- Nested `.choice()` inside a branch is not supported.
- Predicates must be synchronous.
- `otherwise()` may only be registered once per choice (throws otherwise).
