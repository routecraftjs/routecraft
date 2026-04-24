import { ENRICH_MERGE_TYPE } from "./brand.ts";
import { type Adapter, type Step } from "./types.ts";
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
 * shared base class is not a public extension point today.
 *
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
 * Return types thread through the polymorphic `this` via {@link Retyped},
 * so a `.transform()` call on a `RouteBuilder<A>` returns `RouteBuilder<B>`
 * and the same call on `BranchBuilder<A>` returns `BranchBuilder<B>`.
 *
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
    return this as unknown as Retyped<this, R extends void ? Current : R>;
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
    return this as unknown as Retyped<this, Return>;
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
    return this as unknown as Retyped<
      this,
      A extends { [ENRICH_MERGE_TYPE]: infer M } ? Current & M : Current & R
    >;
  }
}
