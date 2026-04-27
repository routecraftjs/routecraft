# Resilience Wrappers

Authoring contract for "dual-mode wrapper" operations: a single builder
method (`.error()`, future `.retry()` / `.timeout()` / `.cache()` /
`.circuitBreaker()` / `.throttle()` / `.delay()`) that applies at
either route scope (when staged before `.from()`) or step scope (when
chained after `.from()`).

The pattern is shared so every future resilience operation has the
same mental model, ESLint behaviour, docs layout, and observability.

---

## 1. Operation categories

Three categories cover every operation in the framework:

| Category | Position | Examples |
|----------|----------|----------|
| Route-only | Before `.from()` only. Configures the route. | `.id()`, `.batch()`, `.title()`, `.description()`, `.input()`, `.output()` |
| Dual-mode wrapper | Same method, position decides scope. | `.error()`, future `.retry()`, `.timeout()`, `.cache()`, `.circuitBreaker()`, `.throttle()`, `.delay()` |
| Pipeline | After `.from()` only. Already enforced by the builder type system. | `.transform()`, `.to()`, `.process()`, `.enrich()`, `.split()`, `.aggregate()`, `.tap()`, `.filter()`, `.validate()`, `.choice()`, `.header()` |

## 2. Dual-mode contract

A dual-mode wrapper exposes one method on the builder. Position decides
scope:

- **Before `.from()`**: route scope. The wrapper applies to the entire
  pipeline. Wired into `RouteDefinition` (or the equivalent feature
  bag); the runtime applies it at the route boundary.
- **After `.from()`**: step scope. The wrapper attaches to the
  immediately next step. Wired by pushing a factory onto the
  builder's pending-wrapper stack; the next call to `pushStep` folds
  the stack around the step.

The handler signature is identical in both positions. Each scope
preserves the builder's body type parameter so a wrapped step does not
break inference for downstream `.to(...)` / `.transform(...)`.

## 3. Stacking order

Multiple wrappers stack outside-in in declaration order. The
first-declared wrapper is the outermost.

```ts
.from(source)
.retry({ attempts: 3 })   // outer
.timeout({ ms: 5_000 })   // middle
.error(handleAuthFailure) // inner
.to(http({ url }))
```

Resolves to `retry(timeout(error(http(...))))`. `error` runs first
(closest to the inner step); if it rethrows, `timeout` sees that
throw; if `timeout` fires its own deadline, `retry` decides whether to
re-attempt the whole stack.

The stack is cleared on every push. A wrapper attaches to exactly one
step.

## 4. Cascade rule (handler failure)

When a step-scope handler itself throws (or the wrapper otherwise
cannot recover), it must rethrow. The runtime cascade is:

1. Outer wrappers in the same step's stack get a chance to handle the
   rethrow (e.g. retry will re-attempt; the rethrow is just one
   attempt's failure).
2. After all step-scope wrappers exhaust, the route-level handler
   (when set) runs, exactly as if the inner step had thrown directly.
3. If no route-level handler exists, the default error path fires:
   `route:<id>:error` + `context:error` + `exchange:failed`.
4. The route is **not** stopped. The next exchange processes
   normally.

The runtime path is the existing outer catch in
`packages/routecraft/src/route.ts`'s `runSteps`. Wrappers piggyback
on it for free by rethrowing on unrecoverable failure.

## 5. Implementation skeleton

A new wrapper takes about 50 lines plus builder glue. Subclass
`WrapperStep<T>` from `packages/routecraft/src/operations/wrapper.ts`
and implement `runInner(exchange)`:

```ts
export class TimeoutWrapperStep<T extends Adapter = Adapter>
  extends WrapperStep<T>
{
  private innerPushed: { exchange: Exchange; steps: Step<Adapter>[] }[] = [];

  constructor(inner: Step<T>, private readonly ms: number) {
    super(inner);
  }

  protected override async runInner(exchange: Exchange): Promise<WrapperOutcome> {
    this.innerPushed = [];
    const innerPromise = this.inner.execute(exchange, [], this.innerPushed);
    const result = await Promise.race([
      innerPromise.then(() => "ok" as const),
      sleep(this.ms).then(() => {
        throw rcError("RC5012", undefined, {
          message: `Step "${this.label}" exceeded ${this.ms}ms timeout`,
        });
      }),
    ]);
    return result;
  }

  protected override drainInnerQueue() {
    return this.innerPushed;
  }
}
```

Then add the dual-mode method on the builder:

```ts
// step-builder-base.ts (step-scope-only on this base)
timeout(opts: { ms: number }): this {
  this.pendingStepWrappers.push(
    (inner) => new TimeoutWrapperStep(inner, opts.ms),
  );
  return this;
}
```

And override on `RouteBuilder` for the dual-mode behaviour:

```ts
override timeout(opts: { ms: number }): this {
  if (this.currentRoute === undefined) {
    // pre-from: stage as route-level
    this.pendingOptions = { ...(this.pendingOptions ?? {}), timeout: opts };
    return this;
  }
  // post-from: delegate to base for step-scope wrap
  return super.timeout(opts);
}
```

Route-scope wiring depends on the operation's semantics. For
`.timeout()` it might apply at the consumer boundary; for `.cache()`
it wraps the whole pipeline; for `.circuitBreaker()` it integrates
with the consumer's backpressure (see "When a wrapper is not enough"
below).

## 6. Observability

Every dual-mode wrapper emits scope-aware lifecycle events:

| Event | When | Bindings |
|-------|------|----------|
| `route:<id>:<wrapper>:invoked` | Wrapper observed a failure or precondition that triggered its behaviour. | `routeId`, `exchangeId`, `correlationId`, `originalError` (or precondition payload), `failedOperation`, `scope: "route" \| "step"`, `stepLabel?` |
| `route:<id>:<wrapper>:recovered` | Wrapper produced a value that lets the pipeline continue. | Same plus `recoveryStrategy`. |
| `route:<id>:<wrapper>:failed` | Wrapper rethrew (or otherwise gave up). | Same. |

For `.error()` the wrapper emits the existing `error-handler:*` set.
A new wrapper picks its own family (e.g. `retry:*`, `timeout:*`,
`cache:*`).

Wildcard subscribers (`route:*:error-handler:*`,
`route:*:retry:*`) keep matching; the new `scope` and `stepLabel`
fields are additive.

## 7. When a wrapper is not enough

Some resilience patterns need consumer-layer integration that pure
step wrapping cannot provide:

| Pattern | Wrapper covers | Wrapper does NOT cover |
|---------|-----------------|------------------------|
| Step-level `.circuitBreaker()` | Trip on N consecutive step failures, fail-fast subsequent calls. | Pausing the consumer during cooldown. |
| Route-level `.circuitBreaker()` | NOT well-served by a wrapper alone. | Pausing the source consumer (HTTP / queue / cron) during cooldown so backpressure flows back to the caller / queue. |
| Route-level `.throttle()` (rate limit on the consumer) | NOT well-served by a wrapper alone. | Token-bucket at the consumer. |

These need a paired `Consumer` integration (a consumer that observes
breaker / throttle state and pauses pulling). Track this constraint
in the new operation's issue and scope its acceptance criteria
accordingly.

## 8. `.standards` checklist for a new wrapper

- [ ] New `XWrapperStep` extends `WrapperStep`, implements
      `runInner` and `drainInnerQueue`.
- [ ] Dual-mode `.x(...)` builder method on `StepBuilderBase` (step
      scope) with an override on `RouteBuilder` for the pre-from
      path.
- [ ] Route-scope wiring documented (where the runtime applies it).
- [ ] Events: `x:invoked`, `x:recovered`, `x:failed` with
      `scope: "route" | "step"` and `stepLabel?`.
- [ ] Tests covering: step-scope happy path, step-scope failure,
      stacked wrappers, handler-failure cascade to route-level, no
      route handler default path, builder body type preserved across
      the wrapper.
- [ ] Docs updated: `docs/introduction/operations`,
      `docs/advanced/error-handling` (or equivalent),
      `docs/reference/operations`, `docs/reference/events`.
- [ ] No em-dashes in docs, JSDoc, comments, or written output.
- [ ] `@experimental` on the new exports until a second wrapper has
      shipped.
- [ ] Conventional Commits.

## 9. Cross-references

- `#187` (source-level parse error recovery): once parsing moves into
  the pipeline, `.error()` wraps the parse step to get "log and skip
  bad rows, continue processing" as a composable pattern.
- `#139` (Circuit Breaker): see "When a wrapper is not enough"; the
  step-scope side is a wrapper, the route-scope side needs consumer
  integration.
- `#112` (Cache): pure wrapper at both scopes; first wrapper after
  `.error()` to validate the pattern at scale.
- `WrapperStep` source: `packages/routecraft/src/operations/wrapper.ts`.
- `ErrorWrapperStep` source:
  `packages/routecraft/src/operations/error-wrapper.ts`.
- Builder hook source:
  `packages/routecraft/src/step-builder-base.ts`
  (`pendingStepWrappers`, `applyPendingWrappers`).
