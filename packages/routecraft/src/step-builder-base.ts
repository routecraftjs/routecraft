import { ENRICH_MERGE_TYPE } from "./brand.ts";
import { type Adapter, type Step } from "./types.ts";
import {
  type Exchange,
  type HeaderValue,
  type HeaderLiteral,
} from "./exchange.ts";
import {
  type Destination,
  type CallableDestination,
  ToStep,
} from "./operations/to.ts";
import {
  type Transformer,
  type CallableTransformer,
  TransformStep,
} from "./operations/transform.ts";
import {
  EnrichStep,
  type DestinationAggregator,
  type EnrichMergeShape,
  type EnrichAggregatorOption,
} from "./operations/enrich.ts";
import { ErrorWrapperStep } from "./operations/error-wrapper.ts";
import {
  CacheWrapperStep,
  type CacheOptions,
} from "./operations/cache-wrapper.ts";
import { DelayWrapperStep } from "./operations/delay-wrapper.ts";
import { TimeoutWrapperStep } from "./operations/timeout-wrapper.ts";
import {
  RetryWrapperStep,
  type RetryOptions,
} from "./operations/retry-wrapper.ts";
import {
  type Processor,
  type CallableProcessor,
  ProcessStep,
} from "./operations/process.ts";
import { TapStep } from "./operations/tap.ts";
import {
  type CallableFilter,
  type Filter,
  FilterStep,
} from "./operations/filter.ts";
import {
  type Validator,
  type CallableValidator,
  ValidateStep,
} from "./operations/validate.ts";
import {
  type CallableAuthenticator,
  AuthenticateStep,
} from "./operations/authenticate.ts";
import { HeaderStep } from "./operations/header.ts";
import type { ErrorHandler } from "./route.ts";
import { PUSH_STEP } from "./dsl-symbol.ts";

/**
 * Builder hook that wraps a single step in a "dual-mode wrapper"
 * (e.g. `.error()`, future `.retry()` / `.timeout()` / `.cache()`).
 * Pushed onto {@link StepBuilderBase}'s pending wrapper stack when the
 * builder method runs in step scope; folded around the next pushed
 * step inside {@link StepBuilderBase.applyPendingWrappers}.
 *
 * @internal
 */
export type StepWrapperFactory = <T extends Adapter>(inner: Step<T>) => Step<T>;

// Type-only imports to avoid a runtime cycle. The `Retyped` conditional below
// resolves `this` into the concrete subclass typed at the new state bag; the
// value side of each subclass is defined in its own module and imports
// StepBuilderBase, not the other way around.
import type { RouteBuilder } from "./builder.ts";
import type { BranchBuilder } from "./operations/choice.ts";

/**
 * The type-state bag threaded through the builder chain.
 *
 * Every builder generic (`RouteBuilder<S>`, `BranchBuilder<S>`,
 * `StepBuilderBase<S>`) is parameterised by ONE bag rather than by loose
 * type arguments, because declaration merging freezes generic arity: the
 * moment an ecosystem package augments `interface StepBuilderBase<S>`, the
 * parameter list can never change again. With a bag, new tracked facets
 * (typed headers, accumulated tags, ...) become new OPTIONAL fields on this
 * interface, which is a non-breaking change for every augmentation already
 * in the wild.
 *
 * `body` is the only field today: the body type entering the next step.
 */
export interface BuilderState {
  /** Body type entering the next pipeline step. */
  body: unknown;
}

/**
 * Replace the `body` field of a state bag, preserving every other (current
 * or future) field. The single way builder methods advance the body type;
 * using it everywhere means a new `BuilderState` field flows through every
 * existing chain method untouched.
 *
 * @template S - The incoming state bag
 * @template B - The new body type
 */
export type SetBody<S extends BuilderState, B> = {
  [K in keyof S]: K extends "body" ? B : S[K];
};

/**
 * Maps the polymorphic `this` type of a `StepBuilderBase` call to the same
 * concrete subclass re-typed at the new state bag `S2`. Enables methods on
 * the shared base class to return `RouteBuilder<S2>` or `BranchBuilder<S2>`
 * automatically based on the receiver at the call site, without each subclass
 * overriding every method to narrow its return.
 *
 * Closed-world on purpose: only the framework-owned subclasses participate.
 * External subclasses fall through to `never`, which is intentional -- the
 * shared base class is not a public extension point today. Any future
 * framework-owned subclass (for example, a `PathBuilder` for multicast) must
 * be added to the union below.
 *
 * @template This - The polymorphic `this` type inside a method on StepBuilderBase
 * @template S2 - The new state bag to re-type the subclass at
 */
// The `infer` holes below are match-only: the builder classes are invariant
// in their state bag, so a structural `extends RouteBuilder<BuilderState>`
// check fails for concrete instantiations; inferential matching does not.
/* eslint-disable @typescript-eslint/no-unused-vars */
export type Retyped<This, S2 extends BuilderState> =
  This extends RouteBuilder<infer _RS extends BuilderState>
    ? RouteBuilder<S2>
    : This extends BranchBuilder<infer _BS extends BuilderState>
      ? BranchBuilder<S2>
      : never;
/* eslint-enable @typescript-eslint/no-unused-vars */

/**
 * Shared abstract base for builders that accumulate pipeline steps.
 *
 * Implements the pipeline operations that are identical across
 * `RouteBuilder` and `BranchBuilder` (`to`, `transform`, `enrich`). Each
 * subclass provides its own `pushStep` hook describing where steps go --
 * `RouteBuilder` pushes into the current route definition (and enforces
 * that `.from()` has been called via `requireSource`), while
 * `BranchBuilder` pushes into its internal step array.
 *
 * Return types are threaded through the polymorphic `this` via
 * {@link Retyped}, so a `.transform()` call on a `RouteBuilder<{ body: A }>`
 * returns `RouteBuilder<{ body: B }>` and the same call on
 * `BranchBuilder<{ body: A }>` returns `BranchBuilder<{ body: B }>`.
 *
 * The class value is framework-internal and must not be subclassed outside
 * the framework (the {@link Retyped} conditional is closed-world and external
 * subclasses would silently resolve to `never`). The TYPE, however, is the
 * documented augmentation point for DSL sugar: `registerDsl` adds the runtime
 * method here, and ecosystem packages declare its type by merging into
 * `interface StepBuilderBase<S extends BuilderState>` (see `registerDsl`).
 *
 * @template S - The {@link BuilderState} bag for the chain position
 */
export abstract class StepBuilderBase<S extends BuilderState = BuilderState> {
  /**
   * Stack of step-scope wrapper factories declared since the last
   * pushed step, in declaration order. Folded around the next pushed
   * step by {@link applyPendingWrappers}; the first-declared wrapper
   * is outermost (`.retry().timeout().process(slow)` means
   * `retry(timeout(process))`). Cleared after each push.
   *
   * @internal
   */
  protected pendingStepWrappers: StepWrapperFactory[] = [];

  /**
   * Fold any wrappers staged since the last push around `step`,
   * returning the (possibly wrapped) step that subclasses should hand
   * to their target collection. Clears the stack on every call so a
   * wrapper attaches to exactly one step.
   *
   * @internal
   */
  protected applyPendingWrappers<T extends Adapter>(step: Step<T>): Step<T> {
    if (this.pendingStepWrappers.length === 0) return step;
    let wrapped: Step<Adapter> = step as Step<Adapter>;
    for (let i = this.pendingStepWrappers.length - 1; i >= 0; i--) {
      const factory = this.pendingStepWrappers[i]!;
      wrapped = factory(wrapped);
    }
    this.pendingStepWrappers = [];
    return wrapped as unknown as Step<T>;
  }

  /**
   * Append a step to the builder's pipeline. Implemented by each subclass
   * to route the step into the right collection (current route definition
   * vs. branch step array). Subclass-specific validation (e.g.
   * `RouteBuilder.requireSource`) lives in the implementation. Subclasses
   * MUST run `step` through {@link applyPendingWrappers} so dual-mode
   * wrappers (`.error()`, future `.retry()`, etc.) attach to the right
   * step.
   *
   * @param step - The step to append
   */
  protected abstract pushStep<T extends Adapter>(step: Step<T>): void;

  /**
   * Attach an error handler to the next step. When the wrapped step
   * throws, the handler runs with `(err, exchange, forward)` (same
   * shape as the route-level handler), its return value replaces
   * `exchange.body`, and the pipeline continues with the next step.
   *
   * On `RouteBuilder`, this method is dual-mode: when called BEFORE
   * `.from()` it stages a route-level catch-all (existing behaviour);
   * when called AFTER `.from()` it wraps the next step. On
   * `BranchBuilder`, it is always step-scope.
   *
   * If the handler itself throws, the wrapper rethrows so the
   * route-level handler (when set) catches it; otherwise the route's
   * default error path fires (`route:*:error`, `context:error`,
   * `exchange:failed`). The route is NOT stopped.
   *
   * Stacks left-to-right: `.error(h1).error(h2).to(dest)` produces
   * `h1` outermost wrapping `h2` wrapping `dest`. `h2` runs first; if
   * it rethrows, `h1` gets a chance.
   *
   * wrapper pattern (see `.standards/resilience-wrappers.md`).
   */
  error(handler: ErrorHandler): this {
    this.pendingStepWrappers.push(
      (inner) => new ErrorWrapperStep(inner, handler),
    );
    return this;
  }

  /**
   * Cache the result of the next step. When a cached value exists for
   * the derived key, the wrapped step is skipped and the cached body
   * replaces `exchange.body`. On a miss, the step runs and its output
   * body is written to the cache for future calls.
   *
   * Only successful executions are cached: if the wrapped step throws,
   * the error propagates and the cache is left untouched. Dropped
   * exchanges (filter / halt) are not cached.
   *
   * Concurrent exchanges with the same key share one computation via
   * the provider's `getOrCompute`, so a slow underlying operation
   * runs at most once per key per TTL window.
   *
   * On `RouteBuilder`, this method is dual-mode. The route-scope
   * variant (called BEFORE `.from()`) is not yet implemented and
   * throws RC2001; for now use the step-scope form chained after
   * `.from()`. On `BranchBuilder`, it is always step-scope.
   *
   * Stacks left-to-right with other wrappers: `.error(h).cache().to(d)`
   * produces `error(cache(d))` -- the cache runs inside the error
   * handler's recovery scope.
   *
   * @param options Optional `{ key, ttl, provider }`. Defaults: key
   *   derived from a SHA-256 of `JSON.stringify(body)`, no TTL,
   *   process-wide in-memory provider.
   *
   * @experimental Step-scope behaviour ships with the dual-mode
   * wrapper pattern (see `.standards/resilience-wrappers.md`).
   */
  cache(options: CacheOptions<S["body"]> = {}): this {
    this.pendingStepWrappers.push(
      (inner) => new CacheWrapperStep(inner, options as CacheOptions),
    );
    return this;
  }

  /**
   * Wait a fixed time before the next step runs. Pass-through: the
   * exchange is unchanged by the wait. The wait is cancelled when the
   * route shuts down mid-wait; the wrapped step still runs, so no
   * exchange is silently dropped by a shutdown.
   *
   * Step scope only: there is no route-scope form (a route-scope delay
   * is equivalent to a delay before the first step) and the pre-from
   * filter chain reserves no slot for it.
   *
   * Stacks with other wrappers in declaration order (first-declared
   * outermost): `.retry().delay(1000).process(op)` waits before each
   * attempt, because retry re-runs the delay-wrapped step.
   *
   * @param delayMs - Milliseconds to wait before the next step
   * @returns This builder (same subclass, same body type)
   */
  delay(delayMs: number): this {
    this.pendingStepWrappers.push(
      (inner) => new DelayWrapperStep(inner, delayMs),
    );
    return this;
  }

  /**
   * Bound the next step with a deadline. When the step settles in time
   * its outcome passes through unchanged; when the deadline fires first
   * the wrapper throws `RC5011` (Request timeout, `retryable: true`),
   * so an outer `.retry()` re-attempts it by default and `.error()`
   * handlers can branch on the code.
   *
   * The step is not cancelled on expiry (promises cannot be
   * cancelled): it keeps running in the background and its eventual
   * result is discarded, so side effects of the abandoned attempt may
   * still happen. The timeout bounds how long the pipeline waits, not
   * the work itself.
   *
   * On `RouteBuilder`, this method is dual-mode: called BEFORE
   * `.from()` it bounds each run of the whole pipeline at pre-from
   * filter chain position 8 (inside `.retry()`, so each attempt gets
   * its own deadline); called AFTER `.from()` it wraps the next step.
   *
   * @param timeoutMs - Deadline in milliseconds
   * @returns This builder (same subclass, same body type)
   */
  timeout(timeoutMs: number): this {
    this.pendingStepWrappers.push(
      (inner) => new TimeoutWrapperStep(inner, timeoutMs),
    );
    return this;
  }

  /**
   * Re-attempt the next step on failure with configurable backoff.
   * Each attempt receives the same (frozen) exchange, so a re-attempt
   * always starts from the input that failed. After the final attempt
   * fails, the original error propagates unchanged to outer wrappers
   * or the route-level handler.
   *
   * By default only errors with `retryable: false` (validation, auth,
   * config) are NOT re-attempted; everything else, including timeouts
   * (`RC5011`) and unknown third-party errors, is retried. Override
   * with `retryOn`.
   *
   * On `RouteBuilder`, this method is dual-mode: called BEFORE
   * `.from()` it re-runs the whole pipeline at pre-from filter chain
   * position 7 (outside `.timeout()`, inside `.error()`); called AFTER
   * `.from()` it wraps the next step.
   *
   * Stacks with other wrappers in declaration order (first-declared
   * outermost): `.retry().timeout(5000).to(dest)` gives each attempt
   * its own 5s deadline.
   *
   * @param options - `maxAttempts` (default 3), `backoffMs` (default
   *   1000), `exponential` (default false), `retryOn` (default: skip
   *   non-retryable RoutecraftErrors)
   * @returns This builder (same subclass, same body type)
   */
  retry(options: RetryOptions = {}): this {
    this.pendingStepWrappers.push(
      (inner) => new RetryWrapperStep(inner, options),
    );
    return this;
  }

  /**
   * Return `this` re-typed to the concrete subclass with the state bag's
   * `body` replaced by `B` (other bag fields preserved).
   *
   * The single cast point used by every pipeline method that changes the
   * body type. Centralising it means `RouteBuilder` and `BranchBuilder`
   * do not each need their own `withType<T>()` helper, and the closed-world
   * {@link Retyped} conditional resolves the return type to the caller's
   * concrete subclass.
   *
   * @template B - New body type
   * @returns This instance, re-typed
   */
  protected retype<B>(): Retyped<this, SetBody<S, B>> {
    return this as unknown as Retyped<this, SetBody<S, B>>;
  }

  /**
   * Send the exchange to a destination. A destination that returns
   * `undefined` leaves the body unchanged; a returned value replaces
   * the body.
   *
   * @param destination - Adapter or callable that processes the exchange
   * @returns The subclass builder re-typed to the destination's output
   * @template R - Result body type; defaults to `void` (body unchanged)
   */
  to<R = void>(
    destination: Destination<S["body"], R> | CallableDestination<S["body"], R>,
  ): Retyped<this, SetBody<S, R extends void ? S["body"] : R>> {
    this.pushStep(new ToStep<S["body"], R>(destination));
    return this.retype<R extends void ? S["body"] : R>();
  }

  /**
   * Transform the exchange body. The transformer receives the current
   * body and returns the replacement body. Headers and exchange identity
   * are preserved. Use `.process()` when the full exchange is needed.
   *
   * @param transformer - Adapter or callable that maps the body to a new value
   * @returns The subclass builder re-typed to the transformer's output
   * @template Return - Result body type
   */
  transform<Return>(
    transformer:
      | Transformer<S["body"], Return>
      | CallableTransformer<S["body"], Return>,
  ): Retyped<this, SetBody<S, Return>> {
    this.pushStep(new TransformStep<S["body"], Return>(transformer));
    return this.retype<Return>();
  }

  /**
   * Enrich the exchange with data from a destination (e.g. HTTP lookup).
   * Uses the same Destination adapters as `.to()` but with a merge-by-default
   * aggregator. Optional aggregator controls how data is combined; `only(...)`
   * and similar helpers carry an `ENRICH_MERGE_TYPE` brand that drives the
   * body-type inference.
   *
   * @param destination - Adapter or callable that returns enrichment data
   * @param aggregator - Optional merge strategy; defaults to spreading result onto body
   * @returns The subclass builder re-typed with the merged body shape
   * @template R - Body type returned by the destination
   * @template A - Aggregator type (drives body shape inference)
   */
  enrich<
    R,
    A extends
      | DestinationAggregator<S["body"], R>
      | (DestinationAggregator<unknown, unknown> & {
          [ENRICH_MERGE_TYPE]?: EnrichMergeShape;
        })
      | undefined = undefined,
  >(
    destination: Destination<S["body"], R> | CallableDestination<S["body"], R>,
    aggregator?: A,
  ): Retyped<
    this,
    SetBody<
      S,
      A extends { [ENRICH_MERGE_TYPE]: infer M } ? S["body"] & M : S["body"] & R
    >
  > {
    this.pushStep(
      new EnrichStep<S["body"], R>(
        destination,
        aggregator as EnrichAggregatorOption<S["body"], R> | undefined,
      ),
    );
    return this.retype<
      A extends { [ENRICH_MERGE_TYPE]: infer M } ? S["body"] & M : S["body"] & R
    >();
  }

  /**
   * Process the exchange with a custom function with full access to
   * headers, body, and context. Use when you need more control than
   * `.transform()` (which only operates on the body).
   *
   * @param processor - Function that receives and returns the exchange
   * @returns The subclass builder re-typed to the processor's output body
   * @template Return - Result body type (defaults to the current body)
   */
  process<Return = S["body"]>(
    processor:
      | Processor<S["body"], Return>
      | CallableProcessor<S["body"], Return>,
  ): Retyped<this, SetBody<S, Return>> {
    this.pushStep(new ProcessStep<S["body"], Return>(processor));
    return this.retype<Return>();
  }

  /**
   * Set or override a single header on the current exchange. Body type is
   * unchanged.
   *
   * @param key - Header key to set (e.g. `x-request-id`, `routecraft.custom`)
   * @param valueOrFn - Static value or a function returning the value from the exchange
   * @returns This builder (same subclass, same body type)
   */
  header(
    key: string,
    valueOrFn:
      | HeaderLiteral
      | ((exchange: Exchange<S["body"]>) => HeaderValue | Promise<HeaderValue>),
  ): this {
    this.pushStep(new HeaderStep<S["body"]>(key, valueOrFn));
    return this;
  }

  /**
   * Establish the authenticated principal for the exchange. The resolver
   * returns identity claims you have verified yourself (an e-mail sender, a
   * Slack signature, a webhook HMAC); they are minted into a branded
   * principal and attached to the exchange. Return `undefined` to leave the
   * caller anonymous. Body type is unchanged.
   *
   * This is the explicit, greppable way to mint identity. `authorize()`
   * trusts only principals established this way (or by a source verifier);
   * a plain object written via `.header("routecraft.auth.principal", ...)`
   * is rejected. Sugar over the `authenticate()` helper.
   *
   * @param resolver - Returns the caller's claims, or `undefined` to skip
   * @returns This builder (same subclass, same body type)
   *
   * @example
   * ```ts
   * craft()
   *   .from(mail("INBOX"))
   *   .filter(verifiedSenders)
   *   .authenticate((ex) => {
   *     // The mail source attaches the computed sender to a header.
   *     const sender = ex.headers["routecraft.mail.sender"];
   *     return {
   *       scheme: "email",
   *       subject: sender.address,
   *       roles: sender.address.endsWith("@acme.com") ? ["internal"] : [],
   *     };
   *   })
   *   .authorize({ roles: ["internal"] })
   *   .to(dest)
   * ```
   */
  authenticate(resolver: CallableAuthenticator<S["body"]>): this {
    this.pushStep(new AuthenticateStep<S["body"]>(resolver));
    return this;
  }

  /**
   * Execute a side effect without changing the data. Fire-and-forget --
   * the tap runs asynchronously (tracked for drain) while the main flow
   * continues. Tap receives a snapshot of the exchange (body/headers
   * cloned). Errors are emitted as events and rethrown for observability,
   * but do not stop the pipeline.
   *
   * @param destination - Destination adapter or callable for the side effect
   * @returns This builder (same subclass, same body type)
   */
  tap(
    destination:
      | Destination<S["body"], unknown>
      | CallableDestination<S["body"], unknown>,
  ): this {
    this.pushStep(new TapStep<S["body"]>(destination));
    return this;
  }

  /**
   * Filter the exchange based on a predicate. Return `true` to keep the
   * exchange, `false` to drop it, or `{ reason: string }` to drop with
   * an explanation recorded in telemetry.
   *
   * @param filter - Filter adapter or callable predicate
   * @returns This builder (same subclass, same body type)
   */
  filter(filter: Filter<S["body"]> | CallableFilter<S["body"]>): this {
    this.pushStep(new FilterStep<S["body"]>(filter));
    return this;
  }

  /**
   * Validate the exchange body using a Validator adapter or callable. On
   * success the (possibly coerced) return value replaces the body. On
   * failure the adapter throws and the route error handler (if configured)
   * or the default error path handles it. For Standard Schema, prefer the
   * `.schema()` sugar or pass the `schema()` factory.
   *
   * @param validator - Validator adapter or callable
   * @returns The subclass builder re-typed to the validator's output body
   * @template R - Output body type after validation (defaults to the current body)
   */
  validate<R = S["body"]>(
    validator: Validator<S["body"], R> | CallableValidator<S["body"], R>,
  ): Retyped<this, SetBody<S, R>> {
    this.pushStep(new ValidateStep<S["body"], R>(validator));
    return this.retype<R>();
  }

  /**
   * Symbol-keyed append used by `registerDsl` to add sugar methods
   * without exposing `pushStep` as public API. Lives on the base so
   * both `RouteBuilder` and `BranchBuilder` inherit it and registered
   * sugar works on both.
   *
   * @internal
   */
  [PUSH_STEP]<T extends Adapter>(step: Step<T>): this {
    this.pushStep(step);
    return this;
  }
}
