import { type Adapter, type Step, type StepOutcome } from "../types.ts";
import {
  type Exchange,
  OperationType,
  HeadersKeys,
  getExchangeContext,
  getExchangeRoute,
  emitExchangeDropped,
} from "../exchange.ts";
import { rcError } from "../error.ts";
import { COLLECT_STEPS } from "../dsl-symbol.ts";
import { StepBuilderBase, type BuilderState } from "../step-builder-base.ts";
import { type Destination } from "./to.ts";

/**
 * Predicate that decides whether a choice branch matches an exchange.
 *
 * Predicates are synchronous by design for phase 1. Async predicates can be
 * introduced later without changing the runtime shape; the branch registration
 * API would add an `asyncWhen` or widen `predicate` to return a Promise.
 *
 * @template T - Body type of the exchange at the point of the choice
 */
export type ChoicePredicate<T = unknown> = (exchange: Exchange<T>) => boolean;

/**
 * A single fan-out path: either a bare destination (the exchange is sent to
 * it) or a callback that builds a sub-pipeline on a {@link PathBuilder}. This
 * is the one shared path shape used by `choice` (`when` / `otherwise`),
 * `multicast`, and future branch operations.
 *
 * A callable destination (a bare function with a `send` method) is NOT a
 * valid bare path here, because it is indistinguishable at runtime from a
 * builder callback; wrap it as `(b) => b.to(callableDest)` instead.
 *
 * @template In  - Body type entering the path
 * @template Out - Body type the path produces (defaults to `In`)
 */
export type Path<In = unknown, Out = In> =
  | Destination<In, unknown>
  | ((b: PathBuilder<{ body: In }>) => PathBuilder<{ body: Out }>);

/**
 * Internal representation of one registered branch: a predicate plus the
 * compiled step array that runs when the predicate matches.
 *
 * @internal
 */
interface ChoiceBranch {
  predicate: ChoicePredicate<unknown>;
  steps: Step<Adapter>[];
  label: "when" | "otherwise";
}

/**
 * Descriptor produced by {@link when}: a predicate plus the path that runs
 * when it matches. Opaque to callers; consumed by `.choice(...)`.
 *
 * @template In  - Body type entering the branch
 * @template Out - Body type the branch produces
 */
export interface WhenDescriptor<In = unknown, Out = In> {
  readonly kind: "when";
  readonly predicate: ChoicePredicate<In>;
  readonly path: Path<In, Out>;
}

/**
 * Descriptor produced by {@link otherwise}: the default path taken when no
 * `when` predicate matches. Opaque to callers; consumed by `.choice(...)`.
 *
 * @template In  - Body type entering the branch
 * @template Out - Body type the branch produces
 */
export interface OtherwiseDescriptor<In = unknown, Out = In> {
  readonly kind: "otherwise";
  readonly path: Path<In, Out>;
}

/**
 * Either kind of branch descriptor accepted by `.choice(...)`.
 *
 * @template In  - Body type entering the branches
 * @template Out - Body type every branch must converge on
 */
export type ChoiceDescriptor<In = unknown, Out = In> =
  | WhenDescriptor<In, Out>
  | OtherwiseDescriptor<In, Out>;

/**
 * Register a conditional branch for `.choice(...)`. The predicate receives
 * the exchange at the point of the choice; the path runs when it returns
 * true. Branches are evaluated in registration order and the first match
 * wins.
 *
 * When `when(...)` is passed directly as a `.choice(...)` argument, the body
 * type flows in by contextual typing, so `ex.body` is typed without an
 * annotation. Only when a descriptor is built OUTSIDE the call (assigned to a
 * variable first) is there no context to infer from; annotate the predicate
 * parameter or supply the `In` type argument
 * (`when<Order>((ex) => ex.body.priority === "urgent", ...)`) in that case.
 *
 * @param predicate - Receives the exchange; returns true if this branch handles it
 * @param path - Bare destination or sub-pipeline callback for the branch
 */
export function when<In = unknown, Out = In>(
  predicate: ChoicePredicate<In>,
  path: Path<In, Out>,
): WhenDescriptor<In, Out> {
  return { kind: "when", predicate, path };
}

/**
 * Register the default branch for `.choice(...)`, taken when no `when`
 * predicate matches. Equivalent to Camel's `.otherwise()`. If omitted and no
 * branch matches, the exchange is dropped with `reason: "unmatched"`. At most
 * one `otherwise` may be passed to a single `.choice(...)`.
 *
 * @param path - Bare destination or sub-pipeline callback for the default branch
 */
export function otherwise<In = unknown, Out = In>(
  path: Path<In, Out>,
): OtherwiseDescriptor<In, Out> {
  return { kind: "otherwise", path };
}

/**
 * Compile one {@link Path} into the step array the executor inlines. A bare
 * destination becomes a single `.to()` step; a callback is run against a
 * fresh {@link PathBuilder} and its collected steps are returned.
 *
 * @internal
 */
export function compilePath(path: Path<unknown, unknown>): Step<Adapter>[] {
  const builder = new PathBuilder();
  if (typeof path === "function") {
    path(builder);
  } else {
    builder.to(path);
  }
  return builder[COLLECT_STEPS]();
}

/**
 * Compile the variadic `.choice(...)` descriptors into the evaluation-ordered
 * branch list: registered `when` branches first, then the optional
 * `otherwise`. Throws (RC5001) if more than one `otherwise` is supplied.
 *
 * @internal
 */
export function compileChoiceBranches(
  descriptors: readonly ChoiceDescriptor<unknown, unknown>[],
): ChoiceBranch[] {
  const whenBranches: ChoiceBranch[] = [];
  let otherwiseBranch: ChoiceBranch | undefined;
  for (const descriptor of descriptors) {
    if (descriptor.kind === "when") {
      whenBranches.push({
        predicate: descriptor.predicate,
        steps: compilePath(descriptor.path),
        label: "when",
      });
    } else {
      if (otherwiseBranch) {
        throw rcError("RC5001", undefined, {
          message:
            "choice() may have at most one otherwise() branch; received two",
        });
      }
      otherwiseBranch = {
        predicate: () => true,
        steps: compilePath(descriptor.path),
        label: "otherwise",
      };
    }
  }
  return otherwiseBranch
    ? [...whenBranches, otherwiseBranch]
    : [...whenBranches];
}

/**
 * Build the {@link ChoiceStep} for a variadic `.choice(...)` call. Keeps the
 * {@link ChoiceStep} value encapsulated in this module so the builder only
 * depends on the helper.
 *
 * @internal
 */
export function buildChoiceStep(
  descriptors: readonly ChoiceDescriptor<unknown, unknown>[],
): ChoiceStep {
  return new ChoiceStep(compileChoiceBranches(descriptors));
}

/**
 * Marker adapter for the HaltStep. Halt has no configuration; the adapter is
 * a zero-field marker so the Step interface shape stays uniform and telemetry
 * can surface the adapter label.
 */
export interface HaltAdapter extends Adapter {
  readonly adapterId: "routecraft.operation.halt";
}

/**
 * Step that short-circuits the pipeline for the current exchange. Used by
 * `b.halt()` inside a path to signal "this path should not continue past the
 * choice / multicast." Emits `exchange:dropped` with reason `"halted"`.
 *
 * Halt is an explicit stop. It is distinct from filter (predicate rejection)
 * and from choice-unmatched (no branch matched); callers can distinguish the
 * three via the `reason` field on the `exchange:dropped` event.
 */
export class HaltStep implements Step<HaltAdapter> {
  operation: OperationType = OperationType.HALT;
  adapter: HaltAdapter = { adapterId: "routecraft.operation.halt" };

  async execute(exchange: Exchange): Promise<StepOutcome> {
    const context = getExchangeContext(exchange);
    const route = getExchangeRoute(exchange);
    const routeId =
      route?.definition.id ??
      (exchange.headers[HeadersKeys.ROUTE_ID] as string);
    const correlationId = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;

    emitExchangeDropped(context, {
      routeId,
      correlationId,
      reason: "halted",
      exchange,
    });

    return { kind: "drop" };
  }
}

/**
 * Sub-builder that defines the step pipeline for a single fan-out path.
 *
 * Exposed to the user as the `b` parameter inside `when(pred, b => ...)`,
 * `otherwise(b => ...)`, and `multicast(b => ...)`. Pipeline operations
 * (`to`, `transform`, `enrich`, ...) are inherited from
 * {@link StepBuilderBase} and behave identically to their counterparts on
 * `RouteBuilder`; the polymorphic return types ensure a chained call re-types
 * this builder as `PathBuilder<NewT>`.
 *
 * PathBuilder adds `.halt()` for explicit short-circuit of the enclosing
 * path. Path-unsafe ops like `.split()` / `.aggregate()` / `.from()` are
 * deliberately absent because they have no coherent meaning inside a path.
 *
 * @template S - The {@link BuilderState} bag entering this path
 */
export class PathBuilder<
  S extends BuilderState = BuilderState,
> extends StepBuilderBase<S> {
  private readonly steps: Step<Adapter>[] = [];

  protected override pushStep<T extends Adapter>(step: Step<T>): void {
    this.steps.push(this.applyPendingWrappers(step));
  }

  /**
   * Short-circuit the pipeline for this exchange. Once `halt()` executes, no
   * further steps run -- neither the remaining path steps nor (for a choice
   * branch) the steps after the enclosing `.choice()` on the main pipeline.
   * The exchange emits `exchange:dropped` with `reason: "halted"`.
   *
   * Useful for branches that handle error cases and do not want the rest of
   * the main pipeline to run, e.g.
   * `.otherwise(b => b.to(errorSink).halt())`.
   *
   * @returns This builder (for chaining, though no further steps will execute)
   */
  halt(): PathBuilder<S> {
    this.pushStep(new HaltStep());
    return this;
  }

  /**
   * Hand the compiled step array to the enclosing step. Symbol-keyed so it
   * does not pollute the public autocomplete surface on the builder.
   *
   * @internal
   */
  [COLLECT_STEPS](): Step<Adapter>[] {
    return this.steps;
  }
}

/**
 * Marker adapter for the ChoiceStep. Exposes no configuration; branches live
 * on the step itself.
 */
export interface ChoiceAdapter extends Adapter {
  readonly adapterId: "routecraft.operation.choice";
}

/**
 * Step that evaluates registered branch predicates in order and inlines the
 * matching branch's steps into the main execution queue. If no branch
 * matches, the exchange is dropped.
 *
 * The branch steps are inlined before the remaining main-pipeline steps, so
 * a matched branch flows naturally back into the main pipeline (convergence
 * semantics). A branch can opt out of convergence by ending in `.halt()`,
 * which sets the dropped flag and prevents further steps from executing.
 */
export class ChoiceStep<In = unknown> implements Step<ChoiceAdapter> {
  operation: OperationType = OperationType.CHOICE;
  adapter: ChoiceAdapter = { adapterId: "routecraft.operation.choice" };
  skipStepEvents = true;

  constructor(private readonly branches: ChoiceBranch[]) {}

  async execute(exchange: Exchange<In>): Promise<StepOutcome> {
    const context = getExchangeContext(exchange);
    const route = getExchangeRoute(exchange);
    const routeId =
      route?.definition.id ??
      (exchange.headers[HeadersKeys.ROUTE_ID] as string);
    const correlationId = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;
    const stepStart = Date.now();

    if (context) {
      context.emit("route:step:started", {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        operation: this.operation,
      });
    }

    let matchedIndex = -1;
    let matchedBranch: ChoiceBranch | undefined;
    for (let i = 0; i < this.branches.length; i++) {
      const branch = this.branches[i];
      let result: boolean;
      try {
        result = branch.predicate(exchange as Exchange<unknown>);
      } catch (error: unknown) {
        if (context) {
          context.emit("route:step:failed", {
            routeId,
            exchangeId: exchange.id,
            correlationId,
            operation: this.operation,
            duration: Date.now() - stepStart,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw rcError("RC5001", error, {
          message: `choice predicate threw (branch index ${i})`,
        });
      }
      if (result) {
        matchedIndex = i;
        matchedBranch = branch;
        break;
      }
    }

    if (!matchedBranch) {
      if (context) {
        context.emit("route:step:completed", {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          operation: this.operation,
          duration: Date.now() - stepStart,
          metadata: { matched: false },
        });
        context.emit("route:operation:choice:unmatched", {
          routeId,
          exchangeId: exchange.id,
          correlationId,
        });
      }
      emitExchangeDropped(context, {
        routeId,
        correlationId,
        reason: "unmatched",
        exchange,
      });
      return { kind: "drop" };
    }

    if (context) {
      context.emit("route:step:completed", {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        operation: this.operation,
        duration: Date.now() - stepStart,
        metadata: { matched: true, branchIndex: matchedIndex },
      });
      context.emit("route:operation:choice:matched", {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        branchIndex: matchedIndex,
        branchLabel: matchedBranch.label,
      });
    }

    return { kind: "branch", exchange, steps: matchedBranch.steps };
  }
}
