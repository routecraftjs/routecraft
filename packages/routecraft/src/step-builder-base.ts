import { ENRICH_MERGE_TYPE } from "./brand.ts";
import { type Adapter, type Step } from "./types.ts";
import { type Exchange, type HeaderValue } from "./exchange.ts";
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
import { HeaderStep } from "./operations/header.ts";
import { PUSH_STEP } from "./dsl-symbol.ts";

// Type-only imports to avoid a runtime cycle. The `Retyped` conditional below
// resolves `this` into the concrete subclass typed at `NewT`; the value side
// of each subclass is defined in its own module and imports StepBuilderBase,
// not the other way around.
import type { RouteBuilder } from "./builder.ts";
import type { BranchBuilder } from "./operations/choice.ts";

/**
 * Maps the polymorphic `this` type of a `StepBuilderBase` call to the same
 * concrete subclass re-typed at the new body type `NewT`. Enables methods on
 * the shared base class to return `RouteBuilder<NewT>` or `BranchBuilder<NewT>`
 * automatically based on the receiver at the call site, without each subclass
 * overriding every method to narrow its return.
 *
 * Closed-world on purpose: only the framework-owned subclasses participate.
 * External subclasses fall through to `never`, which is intentional -- the
 * shared base class is not a public extension point today. Any future
 * framework-owned subclass (for example, a `PathBuilder` for multicast) must
 * be added to the union below.
 *
 * @internal
 * @template This - The polymorphic `this` type inside a method on StepBuilderBase
 * @template NewT - The new body type to re-type the subclass at
 */
export type Retyped<This, NewT> =
  This extends RouteBuilder<unknown>
    ? RouteBuilder<NewT>
    : This extends BranchBuilder<unknown>
      ? BranchBuilder<NewT>
      : never;

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
 * {@link Retyped}, so a `.transform()` call on a `RouteBuilder<A>` returns
 * `RouteBuilder<B>` and the same call on `BranchBuilder<A>` returns
 * `BranchBuilder<B>`.
 *
 * This class is framework-internal. It is not exported from the package
 * entry point and should not be subclassed outside the framework; the
 * {@link Retyped} conditional is closed-world and external subclasses
 * would silently resolve to `never`.
 *
 * @internal
 * @template Current - Body type entering the next step
 */
export abstract class StepBuilderBase<Current = unknown> {
  /**
   * Append a step to the builder's pipeline. Implemented by each subclass
   * to route the step into the right collection (current route definition
   * vs. branch step array). Subclass-specific validation (e.g.
   * `RouteBuilder.requireSource`) lives in the implementation.
   *
   * @param step - The step to append
   */
  protected abstract pushStep<T extends Adapter>(step: Step<T>): void;

  /**
   * Return `this` re-typed to the concrete subclass at a new body type.
   *
   * The single cast point used by every pipeline method that changes
   * `Current`. Centralising it means `RouteBuilder` and `BranchBuilder`
   * do not each need their own `withType<T>()` helper, and the closed-world
   * {@link Retyped} conditional resolves the return type to the caller's
   * concrete subclass.
   *
   * @template T - New body type
   * @returns This instance, re-typed
   */
  protected retype<T>(): Retyped<this, T> {
    return this as unknown as Retyped<this, T>;
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
    destination: Destination<Current, R> | CallableDestination<Current, R>,
  ): Retyped<this, R extends void ? Current : R> {
    this.pushStep(new ToStep<Current, R>(destination));
    return this.retype<R extends void ? Current : R>();
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
      | Transformer<Current, Return>
      | CallableTransformer<Current, Return>,
  ): Retyped<this, Return> {
    this.pushStep(new TransformStep<Current, Return>(transformer));
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
      | DestinationAggregator<Current, R>
      | (DestinationAggregator<unknown, unknown> & {
          [ENRICH_MERGE_TYPE]?: EnrichMergeShape;
        })
      | undefined = undefined,
  >(
    destination: Destination<Current, R> | CallableDestination<Current, R>,
    aggregator?: A,
  ): Retyped<
    this,
    A extends { [ENRICH_MERGE_TYPE]: infer M } ? Current & M : Current & R
  > {
    this.pushStep(
      new EnrichStep<Current, R>(
        destination,
        aggregator as EnrichAggregatorOption<Current, R> | undefined,
      ),
    );
    return this.retype<
      A extends { [ENRICH_MERGE_TYPE]: infer M } ? Current & M : Current & R
    >();
  }

  /**
   * Process the exchange with a custom function with full access to
   * headers, body, and context. Use when you need more control than
   * `.transform()` (which only operates on the body).
   *
   * @param processor - Function that receives and returns the exchange
   * @returns The subclass builder re-typed to the processor's output body
   * @template Return - Result body type (defaults to `Current`)
   */
  process<Return = Current>(
    processor: Processor<Current, Return> | CallableProcessor<Current, Return>,
  ): Retyped<this, Return> {
    this.pushStep(new ProcessStep<Current, Return>(processor));
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
      | HeaderValue
      | ((exchange: Exchange<Current>) => HeaderValue | Promise<HeaderValue>),
  ): this {
    this.pushStep(new HeaderStep<Current>(key, valueOrFn));
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
      | Destination<Current, unknown>
      | CallableDestination<Current, unknown>,
  ): this {
    this.pushStep(new TapStep<Current>(destination));
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
  filter(filter: Filter<Current> | CallableFilter<Current>): this {
    this.pushStep(new FilterStep<Current>(filter));
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
   * @template R - Output body type after validation (defaults to `Current`)
   */
  validate<R = Current>(
    validator: Validator<Current, R> | CallableValidator<Current, R>,
  ): Retyped<this, R> {
    this.pushStep(new ValidateStep<Current, R>(validator));
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
