import { type Adapter, type Step, type EventName } from "../types.ts";
import {
  type Exchange,
  OperationType,
  HeadersKeys,
  getExchangeContext,
  getExchangeRoute,
} from "../exchange.ts";
import { rcError } from "../error.ts";
import { COLLECT_STEPS } from "../dsl-symbol.ts";
import { type Destination, type CallableDestination, ToStep } from "./to.ts";

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
 * Marker adapter for the HaltStep. Halt has no configuration; the adapter is
 * a zero-field marker so the Step interface shape stays uniform and telemetry
 * can surface the adapter label.
 */
export interface HaltAdapter extends Adapter {
  readonly adapterId: "routecraft.operation.halt";
}

/**
 * Step that short-circuits the pipeline for the current exchange. Used by
 * `b.halt()` inside a choice branch to signal "this branch should not
 * continue past the choice." Emits `exchange:dropped` with reason `"halted"`.
 *
 * Halt is an explicit stop. It is distinct from filter (predicate rejection)
 * and from choice-unmatched (no branch matched); callers can distinguish the
 * three via the `reason` field on the `exchange:dropped` event.
 */
export class HaltStep implements Step<HaltAdapter> {
  operation: OperationType = OperationType.HALT;
  adapter: HaltAdapter = { adapterId: "routecraft.operation.halt" };
  skipStepEvents = true;

  async execute(exchange: Exchange): Promise<void> {
    const context = getExchangeContext(exchange);
    const route = getExchangeRoute(exchange);
    const routeId =
      route?.definition.id ??
      (exchange.headers[HeadersKeys.ROUTE_ID] as string);
    const correlationId = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;

    if (context) {
      context.emit(`route:${routeId}:step:started` as EventName, {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        operation: this.operation,
      });
      context.emit(`route:${routeId}:step:completed` as EventName, {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        operation: this.operation,
        duration: 0,
      });
      context.emit(`route:${routeId}:exchange:dropped` as EventName, {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        reason: "halted",
        exchange,
      });
    }

    exchange.headers["routecraft.dropped"] = true;
  }
}

/**
 * Sub-builder that defines the step pipeline for a single choice branch.
 *
 * Exposed to the user as the `b` parameter inside `when(pred, b => ...)` and
 * `otherwise(b => ...)` callbacks. Intentionally narrow: phase 1 only exposes
 * `.to()` and `.halt()`. Other pipeline operations (`transform`, `enrich`,
 * `filter`, ...) will be added in subsequent phases by delegating to the
 * shared step-adding logic.
 *
 * @template Current - Body type entering this branch
 */
export class BranchBuilder<Current = unknown> {
  private readonly steps: Step<Adapter>[] = [];

  /**
   * Send the exchange to a destination inside this branch. Mirrors the
   * semantics of `RouteBuilder.to`: a destination that returns `undefined`
   * leaves the body unchanged; a returned value replaces the body.
   *
   * @template R - Result body type; defaults to `void` (body unchanged)
   */
  to<R = void>(
    destination: Destination<Current, R> | CallableDestination<Current, R>,
  ): BranchBuilder<R extends void ? Current : R> {
    this.steps.push(new ToStep<Current, R>(destination));
    return this as unknown as BranchBuilder<R extends void ? Current : R>;
  }

  /**
   * Short-circuit the pipeline for this exchange. Once `halt()` executes, no
   * further steps run -- neither the remaining branch steps nor the steps
   * after the enclosing `.choice()` on the main pipeline. The exchange emits
   * `exchange:dropped` with `reason: "halted"`.
   *
   * Useful for branches that handle error cases and do not want the rest of
   * the main pipeline to run, e.g.
   * `.otherwise(b => b.to(errorSink).halt())`.
   */
  halt(): BranchBuilder<Current> {
    this.steps.push(new HaltStep());
    return this;
  }

  /**
   * Hand the compiled step array to the enclosing ChoiceStep. Symbol-keyed so
   * it does not pollute the public autocomplete surface on the branch
   * builder.
   *
   * @internal
   */
  [COLLECT_STEPS](): Step<Adapter>[] {
    return this.steps;
  }
}

/**
 * Sub-builder exposed to the user inside `.choice(c => ...)`.
 *
 * Holds the list of registered branches. `when` branches are evaluated in
 * registration order; `otherwise` (if present) is always evaluated last.
 * Calling `otherwise` more than once on the same choice is an authoring
 * mistake and throws at configuration time (RC5001).
 *
 * @template In  - Body type entering the choice (from the main pipeline)
 * @template Out - Body type leaving the choice (all branches must converge)
 */
export class ChoiceSubBuilder<In = unknown, Out = In> {
  private readonly whenBranches: ChoiceBranch[] = [];
  private otherwiseBranch?: ChoiceBranch;

  /**
   * Register a conditional branch. The predicate receives the exchange at the
   * point of the choice; the branch callback defines the sub-pipeline that
   * runs when the predicate returns true. Branches are evaluated in the
   * order they are registered and the first match wins.
   */
  when(
    predicate: ChoicePredicate<In>,
    branchFn: (b: BranchBuilder<In>) => BranchBuilder<Out>,
  ): this {
    const branch = new BranchBuilder<In>();
    branchFn(branch);
    this.whenBranches.push({
      predicate: predicate as ChoicePredicate<unknown>,
      steps: branch[COLLECT_STEPS](),
      label: "when",
    });
    return this;
  }

  /**
   * Register the default branch that runs when no `when` predicate matches.
   * Equivalent to Camel's `.otherwise()`. If omitted and no branch matches,
   * the exchange is dropped with `reason: "unmatched"`.
   */
  otherwise(branchFn: (b: BranchBuilder<In>) => BranchBuilder<Out>): this {
    if (this.otherwiseBranch) {
      throw rcError("RC5001", undefined, {
        message:
          "choice() may have at most one otherwise() branch; called twice",
      });
    }
    const branch = new BranchBuilder<In>();
    branchFn(branch);
    this.otherwiseBranch = {
      predicate: () => true,
      steps: branch[COLLECT_STEPS](),
      label: "otherwise",
    };
    return this;
  }

  /**
   * Return the list of branches in evaluation order: registered `when`
   * branches first, then the optional `otherwise` branch.
   *
   * @internal
   */
  [COLLECT_STEPS](): ChoiceBranch[] {
    return this.otherwiseBranch
      ? [...this.whenBranches, this.otherwiseBranch]
      : [...this.whenBranches];
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

  async execute(
    exchange: Exchange<In>,
    remainingSteps: Step<Adapter>[],
    queue: { exchange: Exchange; steps: Step<Adapter>[] }[],
  ): Promise<void> {
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
      context.emit(`route:${routeId}:step:started` as EventName, {
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
          context.emit(`route:${routeId}:step:failed` as EventName, {
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
        context.emit(`route:${routeId}:step:completed` as EventName, {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          operation: this.operation,
          duration: Date.now() - stepStart,
          metadata: { matched: false },
        });
        context.emit(
          `route:${routeId}:operation:choice:unmatched` as EventName,
          {
            routeId,
            exchangeId: exchange.id,
            correlationId,
          },
        );
        context.emit(`route:${routeId}:exchange:dropped` as EventName, {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          reason: "unmatched",
          exchange,
        });
      }
      exchange.headers["routecraft.dropped"] = true;
      return;
    }

    if (context) {
      context.emit(`route:${routeId}:step:completed` as EventName, {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        operation: this.operation,
        duration: Date.now() - stepStart,
        metadata: { matched: true, branchIndex: matchedIndex },
      });
      context.emit(`route:${routeId}:operation:choice:matched` as EventName, {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        branchIndex: matchedIndex,
        branchLabel: matchedBranch.label,
      });
    }

    queue.push({
      exchange,
      steps: [...matchedBranch.steps, ...remainingSteps],
    });
  }
}
