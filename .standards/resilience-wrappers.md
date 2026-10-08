# Resilience Wrappers

Authoring contract for "dual-mode wrapper" operations: a single builder
method (`.error()`, `.cache()`, `.retry()`, `.timeout()`,
`.throttle()`, `.circuitBreaker()`, `.concurrency()`) that applies at either route scope
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
| Dual-mode wrapper | Same method, position decides scope. | `.error()`, `.cache()`, `.retry()`, `.timeout()`, `.throttle()`, `.circuitBreaker()`, `.concurrency()` |
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
.retry({ maxAttempts: 3 }) // outer
.timeout("5s")             // middle
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

### What a step-scope `.error()` handler may return

The three plain answers (a recovery body, `recovery.drop()`,
`recovery.rethrow()`) all work at step scope, because none of them needs
to know WHERE in the route the wrapper sits.

`recovery.defer()` does, and is refused there with `RC5051`. A park needs
a POSITION to revive at, and positions are assigned by the defer-site walk
to the entries of `definition.steps`, which is the OUTERMOST wrapper of a
stack: an `.error()` wrapped by a `.retry()` is not in that array at all
and cannot look its own site up. A park resolved by guessing would revive
a continuation that re-enters the stack somewhere the approval was never
taken against, which is the class of bug the site walk exists to prevent.

The two scopes that CAN name a position reach the same failure: the
route-scope `.error()` handler, and an error-slot hook. Both leave
the resolution to the executor, which holds the failing step. If a future
change gives a wrapper a stable address within the walk, this refusal is
what should be revisited, and the message names the alternatives so a user
is never merely blocked.

## 5. Implementation skeleton

A new wrapper takes about 30 lines plus builder glue. Subclass
`WrapperStep<T>` from `packages/routecraft/src/operations/wrapper.ts`
and implement `runInner(exchange, ctx)`, returning the inner step's
`StepOutcome` (or a substitute outcome on recovery), and
`describeOptions()`, returning the options the wrapper was built with.

A wrapper that is a chain position at route scope (`retry`, `timeout`,
`circuitBreaker`, `concurrency`, `throttle`, `cache`) holds no behaviour
of its own: the behaviour is the provider's position, and the wrapper
resolves the provider through the port when the exchange runs
(both helpers live in `operations/position-run.ts` and build once per
application, except the throttle position, which `positionFor` builds once
per route through `perRoute` because its gate bakes the route id into its
events). `runStepPosition` resolves a `Position` from `RESILIENCE` and
runs it with a `PositionRun` whose `attempt` is the wrapped step and whose
`scope` is `"step"`; the cache wrapper resolves its position from `CACHE`
through `positionFor` and runs it with a `CacheRun`, that port's own run
shape. That is what makes one plugin replacing a port fill both scopes:

```ts
import { runStepPosition } from "./position-run.ts";

export class TimeoutWrapperStep<
  T extends Adapter = Adapter,
> extends WrapperStep<T> {
  readonly #options: ResolvedTimeoutOptions;
  readonly #positions = new WeakMap<object, Position>();

  constructor(inner: Step<T>, duration: Duration) {
    super(inner);
    this.#options = resolveTimeoutOptions(duration);
  }

  protected override describeOptions(): unknown {
    return this.#options;
  }

  protected override runInner(
    exchange: Exchange,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    return runStepPosition(
      this,
      this.inner,
      this.#positions,
      "timeout",
      (provider) => provider.timeout(this.#options),
      exchange,
      ctx,
    );
  }
}
```

A wrapper that is NOT a position (`.error()`, `.delay()`) implements its
behaviour in `runInner` directly.

Key contract points:

- The inner step never sees the engine's work queue: it returns a `StepOutcome` (`continue` / `complete` / `drop` / `branch` / `fanOut`) and the pipeline executor owns all scheduling. A failed inner step has, by construction, scheduled nothing, so recovery simply substitutes an outcome (typically `{ kind: "continue", exchange: recovered }`). There is no buffer to capture, relay, or clear.
- Pass `ctx` (the `StepContext`) through to `this.inner.execute(exchange, ctx)` unchanged; it carries the narrow executor capabilities (e.g. `takePending` for join steps) and the wrapper must not intercept them. One sanctioned exception: a position that owns a cancellation boundary (`timeout`) abandons its attempt through the signal it passes to `attempt(signal)`, which `stepPositionRun` links with any enclosing `ctx.signal` via `AbortSignal.any`, leaving every other capability untouched, so the inner step can abort cancellation-aware IO when the earliest enclosing deadline fires.
- The provider's events carry `scope` and `stepLabel` from the run, so a step-scope run emits `scope: "step"` with the wrapped step's label and a route-scope run `scope: "route"`; a position never hard-codes either.
- Throwing from `runInner` propagates out so the executor's catch in `pipeline/executor.ts` cascades to the route-level handler (or default error path). Wrappers do not need to re-emit `step:failed` themselves; the template emits it via try/catch.
- `describeOptions()` is abstract, so a wrapper that omits it does not compile. A step-scope `.cache()` stacked above the wrapper, and a route-scope `.cache()` over the pipeline, fold the returned value into the default key (see section 9), so an edit to the wrapper's options misses instead of replaying entries the old options produced. Return all of the resolved configuration, presentation fields such as an event `label` included, the same way a step's own label is part of its definition fingerprint: a rename costs one cold cache, never a wrong hit. Return configuration, never runtime state: callables as themselves (their source is hashed), plain data as plain data, and `null` for a wrapper with no options. A controller or other live object projects to `[opaque]` and contributes nothing.

Then add the dual-mode method on the builder:

```ts
// step-builder-base.ts (step-scope-only on this base)
timeout(duration: Duration): this {
  this.pendingStepWrappers.push(
    (inner) => new TimeoutWrapperStep(inner, duration),
  );
  return this;
}
```

And override on `RouteBuilder` for the dual-mode behaviour:

```ts
override timeout(duration: Duration): this {
  if (this.currentRoute === undefined) {
    // pre-from: stage as route-level
    this.pendingOptions = {
      ...(this.pendingOptions ?? {}),
      timeoutConfig: resolveTimeoutOptions(duration),
    };
    return this;
  }
  // post-from: delegate to base for step-scope wrap
  return super.timeout(duration);
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
- [ ] `describeOptions()` returns the wrapper's whole resolved
      configuration (callables and presentation fields such as `label`
      included), not its runtime state.
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
- `#139` (Circuit Breaker): shipped at both scopes (step-scope wrapper +
  route-scope segment). See "When a wrapper is not enough" for the
  outstanding consumer-pausing follow-up (pausing the source from pulling
  during cooldown).
- `#112` (Cache): dual-mode at both scopes. Step-scope wraps the
  immediately-next step via `CacheWrapperStep`. Route-scope (called
  BEFORE `.from()`) caches the route's terminal body and skips the
  whole pipeline on a hit. The default key (`defaultCacheKey` in
  `operations/cache-wrapper.ts`) at both scopes hashes the route id,
  at route scope the `pipelineFingerprint` of every step a hit skips
  (each step's definition, the kind and `describeOptions()` fingerprint
  of every wrapper, nested sub-pipelines with the predicate selecting
  each `.choice()` branch; computed once in `RouteBuilder.build()` and
  stored as `RouteDefinition.cachePipeline`), at step scope the cache's
  site (`CacheKeyScope`: the step's
  pre-order index, the cache's index in the full wrapper stack, the
  kind and `describeOptions()` fingerprint of each wrapper below it,
  and the innermost step's definition fingerprint), the principal's
  issuer and subject with each `actor` hop, and the body; a custom
  `key` is verbatim (see
  `.standards/security.md` § 4). Only wrappers below the cache enter
  the site with their options: they shape what the cache stores, while
  a wrapper above it runs outside the cached computation and passes the
  exchange inward unchanged, so its options cannot change an entry and
  only its presence counts (through the stack index). The route's
  `.input()` / `.output()` schemas stay out of the route-scope
  fingerprint: input validation runs before the cache check and yields
  the body the key hashes, and output validation runs on a hit as on a
  miss, so neither shapes a stored entry. No fingerprint covers what a
  callable closes over or config read at run time. Route scope is
  refused at build on a
  route whose pipeline contains `.authenticate()`, because a hit would
  skip it. Route scope is
  configured on `RouteDefinition.cache` and filled by the `CACHE`
  provider as the `cache-check` (position #9) and `cache-store`
  (position #10) steps; see
  [Pre-from Filter Chain](./pre-from-filter-chain.md) for the full
  composition contract. Routes with an unbalanced `.split()` (no
  matching `.aggregate()`) reject route-scope cache at build time
  (`RC5003`); balanced `split + aggregate` is supported and caches
  the aggregated terminal body.
- [Pre-from Filter Chain](./pre-from-filter-chain.md): the
  route-scope counterpart of this contract. Documents the fixed
  ordered chain (`error` -> `authorize` -> `parse` -> `input` ->
  `throttle` -> `circuitBreaker` -> `retry` -> `timeout` ->
  `concurrency` -> `cacheCheck` -> pipeline -> `cacheStore`); every position is now filled
  by a shipped operation (see section 1).
- `WrapperStep` source: `packages/routecraft/src/operations/wrapper.ts`.
- `ErrorWrapperStep` source:
  `packages/routecraft/src/operations/error-wrapper.ts`.
- Builder hook source:
  `packages/routecraft/src/step-builder-base.ts`
  (`pendingStepWrappers`, `applyPendingWrappers`).
