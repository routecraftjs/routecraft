# Resilience Wrappers

Authoring contract for "dual-mode wrapper" operations: a single builder
method (`.error()`, `.cache()`, `.retry()`, `.timeout()`,
`.throttle()`, `.circuitBreaker()`) that applies at either route scope
(when staged before `.from()`) or step scope (when chained after
`.from()`). `.delay()` follows the step-scope half of this contract but
is deliberately step-scope only: a route-scope delay is equivalent to a
delay before the first step, and the pre-from filter chain reserves no
slot for it.

The pattern is shared so every future resilience operation has the
same mental model, ESLint behaviour, docs layout, and observability.

---

## 1. Operation categories

Three categories cover every operation in the framework:

| Category | Position | Examples |
|----------|----------|----------|
| Route-only | Before `.from()` only. Configures the route. | `.id()`, `.batch()`, `.title()`, `.description()`, `.input()`, `.output()` |
| Dual-mode wrapper | Same method, position decides scope. | `.error()`, `.cache()`, `.retry()`, `.timeout()`, `.throttle()`, `.circuitBreaker()` |
| Step-only wrapper | After `.from()` only; wraps the next step. | `.delay()` (no route-scope form by design) |
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
   `route:error` + `context:error` + `route:exchange:failed`.
4. The route is **not** stopped. The next exchange processes
   normally.

The runtime path is the existing catch in
`packages/routecraft/src/pipeline/executor.ts`'s `runPipeline`.
Wrappers piggyback on it for free by rethrowing on unrecoverable
failure.

## 5. Implementation skeleton

A new wrapper takes about 40 lines plus builder glue. Subclass
`WrapperStep<T>` from `packages/routecraft/src/operations/wrapper.ts`
and implement `runInner(exchange, ctx)`, returning the inner step's
`StepOutcome` (or a substitute outcome on recovery):

```ts
export class TimeoutWrapperStep<T extends Adapter = Adapter>
  extends WrapperStep<T>
{
  constructor(inner: Step<T>, private readonly ms: number) {
    super(inner);
  }

  protected override async runInner(
    exchange: Exchange,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    return await Promise.race([
      this.inner.execute(exchange, ctx),
      sleep(this.ms).then(() => {
        throw rcError("RC5011", undefined, {
          message: `Step "${this.label}" exceeded ${this.ms}ms timeout`,
        });
      }),
    ]);
  }
}
```

Key contract points:

- The inner step never sees the engine's work queue: it returns a `StepOutcome` (`continue` / `complete` / `drop` / `branch` / `fanOut`) and the pipeline executor owns all scheduling. A failed inner step has, by construction, scheduled nothing, so recovery simply substitutes an outcome (typically `{ kind: "continue", exchange: recovered }`). There is no buffer to capture, relay, or clear.
- Pass `ctx` (the `StepContext`) through to `this.inner.execute(exchange, ctx)` unchanged; it carries the narrow executor capabilities (e.g. `takePending` for join steps) and the wrapper must not intercept them.
- Throwing from `runInner` propagates out so the executor's catch in `pipeline/executor.ts` cascades to the route-level handler (or default error path). Wrappers do not need to re-emit `step:failed` themselves; the template emits it via try/catch.

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
| `route:<wrapper>:invoked` | Wrapper observed a failure or precondition that triggered its behaviour. | `routeId`, `exchangeId`, `correlationId`, `originalError` (or precondition payload), `failedOperation`, `scope: "route" \| "step"`, `stepLabel?` |
| `route:<wrapper>:recovered` | Wrapper produced a value that lets the pipeline continue. | Same plus `recoveryStrategy`. |
| `route:<wrapper>:failed` | Wrapper rethrew (or otherwise gave up). | Same. |

Event names are a fixed set; route identity lives in the payload
(`routeId`), never in the name. Declare the new names in
`EventDetailsMap` (`packages/routecraft/src/types.ts`).

For `.error()` the wrapper emits the existing `error-handler:*` set.
A new wrapper picks its own family (e.g. `retry:*`, `timeout:*`,
`cache:*`).

The `invoked` / `recovered` / `failed` triple above is the default
shape, but a wrapper whose domain does not map cleanly onto it MAY
emit a domain-specific family instead, as long as it keeps the
`scope` / `stepLabel` bindings. `.cache()` is the first such case: it
emits `cache:hit` / `cache:miss` / `cache:stored` / `cache:failed`
(with `cache:failed` carrying a `phase` discriminator) because
"hit/miss/stored" describes cache behaviour far better than
"invoked/recovered". When you diverge, document the family in the
operation's reference page and in `docs/reference/events`.

Subscribers use exact names plus payload filtering
(`forRoute(routeId, handler)`); the `scope` and `stepLabel` fields
are additive.

## 7. When a wrapper is not enough

Some resilience patterns need consumer-layer integration that pure
step wrapping cannot provide:

| Pattern | Wrapper covers | Wrapper does NOT cover |
|---------|-----------------|------------------------|
| Step-level `.circuitBreaker()` | Trip on N consecutive step failures, fail-fast subsequent calls. | Pausing the consumer during cooldown. |
| Route-level `.circuitBreaker()` | NOT well-served by a wrapper alone. | Pausing the source consumer (HTTP / queue / cron) during cooldown so backpressure flows back to the caller / queue. |
| Route-level `.throttle()` (rate limit on the route) | Pacing exchanges through a shared token bucket so downstream calls stay within the rate (shipped as a flat gate at chain position #5). | Pausing the source consumer so it stops PULLING; the shipped gate paces in-flight exchanges instead, so under high concurrency they queue in memory. |

The circuit breaker (#139) shipped its fast-fail half at both scopes:
the step-scope wrapper trips on counted failures and fast-fails the
wrapped step (fallback or `RC5025`), and the route-scope segment does the
same for the whole pipeline. What it does NOT yet do is pause the source
consumer during cooldown, so an open route-scope breaker fast-fails each
exchange (flowing backpressure to the caller) but the consumer keeps
pulling. That paired `Consumer` integration (a consumer that observes
breaker state and pauses pulling) is a tracked follow-up, the same shape
as throttle's: throttle shipped its wrapper / gate half (#151) and its
consumer-pausing half (true source backpressure, plus the `maxQueueSize`
bound on in-flight exchanges) remains outstanding. Track this kind of
constraint in the operation's issue and scope its acceptance criteria
accordingly.

## 8. `.standards` checklist for a new wrapper

- [ ] New `XWrapperStep` extends `WrapperStep`, implements
      `runInner(exchange, ctx)` returning a `StepOutcome` (pass `ctx`
      straight to `this.inner.execute`; never store per-EXECUTION
      state on `this`, since one wrapper instance is shared across
      every exchange on the route). Per-ROUTE shared state IS allowed
      and is sometimes the point: `.throttle()` keeps its token bucket
      on `this` precisely so all exchanges share one rate limiter.
      The rule bars leaking one exchange's state into the next, not
      deliberately shared route-level state.
- [ ] Dual-mode `.x(...)` builder method on `StepBuilderBase` (step
      scope) with an override on `RouteBuilder` for the pre-from
      path.
- [ ] Route-scope wiring documented (where the runtime applies it).
- [ ] Events: `route:x:invoked`, `route:x:recovered`, `route:x:failed`
      (or a documented domain-specific family per section 6, e.g.
      `cache:hit/miss/stored`, `retry:started/attempt/stopped`)
      declared in `EventDetailsMap` with `routeId`,
      `scope: "route" | "step"` and `stepLabel?` in the payload.
- [ ] Tests covering: step-scope happy path, step-scope failure,
      stacked wrappers, handler-failure cascade to route-level, no
      route handler default path, builder body type preserved across
      the wrapper.
- [ ] Docs updated: `docs/introduction/operations`,
      `docs/advanced/error-handling` (or equivalent),
      `docs/reference/operations`, `docs/reference/events`.
- [ ] No em-dashes in docs, JSDoc, comments, or written output.
- [ ] `@internal` on any helper exports that are not meant to be public
      (0.x uses no `@experimental` / `@beta` tiers).
- [ ] Conventional Commits.

## 9. Cross-references

- `#187` (source-level parse error recovery): once parsing moves into
  the pipeline, `.error()` wraps the parse step to get "log and skip
  bad rows, continue processing" as a composable pattern.
- `#139` (Circuit Breaker): see "When a wrapper is not enough"; the
  step-scope side is a wrapper, the route-scope side needs consumer
  integration.
- `#112` (Cache): dual-mode at both scopes. Step-scope wraps the
  immediately-next step via `CacheWrapperStep`. Route-scope (called
  BEFORE `.from()`) caches the route's terminal body keyed by the
  source-emitted message and skips the whole pipeline on a hit;
  wired into `RouteDefinition.postParseFilters` (the `cache-check`
  filter at chain position #9) and `RouteDefinition.postFromFilters`
  (the `cache-store` filter at position #10); see
  [Pre-from Filter Chain](./pre-from-filter-chain.md) for the full
  composition contract. Routes with an unbalanced `.split()` (no
  matching `.aggregate()`) reject route-scope cache at build time
  (`RC5003`); balanced `split + aggregate` is supported and caches
  the aggregated terminal body.
- [Pre-from Filter Chain](./pre-from-filter-chain.md): the
  route-scope counterpart of this contract. Documents the fixed
  ordered chain (`error` -> `authorize` -> `parse` -> `input` ->
  `throttle` -> `circuitBreaker` -> `retry` -> `timeout` ->
  `cacheCheck` -> pipeline -> `cacheStore`) and reserves slots for
  the future resilience wrappers listed in section 1.
- `WrapperStep` source: `packages/routecraft/src/operations/wrapper.ts`.
- `ErrorWrapperStep` source:
  `packages/routecraft/src/operations/error-wrapper.ts`.
- Builder hook source:
  `packages/routecraft/src/step-builder-base.ts`
  (`pendingStepWrappers`, `applyPendingWrappers`).
