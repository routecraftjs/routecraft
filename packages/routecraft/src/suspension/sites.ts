import type { StandardSchemaV1 } from "@standard-schema/spec";
import { rcError } from "../error.ts";
import { OperationType } from "../exchange.ts";
import { NESTED_STEPS } from "../dsl-symbol.ts";
import type { Adapter, Step } from "../types.ts";
import type { RouteDefinition } from "../route.ts";

/**
 * Where a `.suspend()` sits in a route, and what runs when it is resumed.
 *
 * Resolved once at `craft().build()` time and stored on the route
 * definition, for one reason: execution two happens in a different process,
 * so the continuation cannot be a closure captured at suspend time. It has
 * to be re-derivable from the route definition alone, and a site is exactly
 * that derivation.
 */
export interface SuspendSite {
  /**
   * Stable address of the suspending step within the route.
   *
   * The index of the step in a pre-order walk of the route's step tree, not
   * an index into `definition.steps`: a suspend inside a `.choice()` branch
   * is a real position that a flat index cannot name. Two processes running
   * the same route source derive the same numbers, which is all the address
   * has to guarantee. The record's `position` field carries it, and
   * `position + 1` onward is {@link SuspendSite.continuation}.
   */
  readonly position: number;
  /**
   * The steps that run on resume, flattened in execution order.
   *
   * For a suspend on the main flow this is simply the steps after it. For a
   * suspend inside a `.choice()` branch it is the rest of that branch
   * followed by the steps after the choice, which is the same sequence the
   * executor would have run had the exchange never parked (a matched branch
   * rejoins the main flow).
   */
  readonly continuation: ReadonlyArray<Step<Adapter>>;
}

/**
 * What a `suspend` outcome hands the executor.
 *
 * The step resolves the pieces (its schema, its expiry, its site) and the
 * executor owns the effects (serialize, hash, store, emit), which keeps
 * every scheduling decision in one place, as with every other outcome kind.
 *
 * It lives here rather than beside the operation because `types.ts` names
 * it on the `StepOutcome` union, and `types.ts` is the dependency root: it
 * does not import from `operations/`.
 *
 * @internal
 */
export interface SuspendRequest {
  /** Live schema the eventual answer is validated against. */
  readonly expect: StandardSchemaV1;
  /** Resolved TTL in milliseconds, when one was declared. */
  readonly expiresInMs?: number;
  /** Where this suspend sits, and what runs on resume. */
  readonly site: SuspendSite;
}

/**
 * A step that can park the exchange. Implemented by the `.suspend()` step;
 * declared here so the walk can recognise one without importing the
 * operation (which imports this module back).
 *
 * @internal
 */
export interface SuspendableStep extends Step<Adapter> {
  readonly operation: OperationType.SUSPEND;
  /**
   * The live `expect` schema. Read back off the step at resume time to
   * validate the candidate answer, because a Standard Schema cannot be
   * persisted with the record.
   */
  readonly expect: StandardSchemaV1;
  /** Assigned by {@link resolveSuspendSites}. Absent means the step is not reachable from a built route. */
  site?: SuspendSite;
}

/**
 * One nested sub-pipeline of a step, as reported through
 * {@link NESTED_STEPS}.
 *
 * `rejoins` is the load-bearing field. A `.choice()` branch flows back into
 * the main pipeline when it matches, so a suspend inside one has a
 * well-defined continuation that spans the branch tail and the main tail. A
 * `.multicast()` path or a `.dispatch()` target runs as an isolated nested
 * pipeline whose exchange is not the route's primary flow, so there is no
 * such continuation and a suspend inside one is refused.
 */
export interface NestedSteps {
  readonly steps: ReadonlyArray<Step<Adapter>>;
  readonly rejoins: boolean;
}

/** A step that carries nested sub-pipelines. @internal */
interface NestingStep extends Step<Adapter> {
  [NESTED_STEPS](): ReadonlyArray<NestedSteps>;
}

/**
 * Resolve every `.suspend()` site in a route, refusing the positions where
 * a durable park cannot be revived.
 *
 * Runs at build time so an incoherent route fails on the deploy that
 * introduced it rather than on the first large payout. Assigns each
 * suspending step its {@link SuspendSite} as a side effect, because the
 * step is what the executor holds when the outcome comes back.
 *
 * @param route - A finalised route definition
 * @returns Every suspending step in the route, in pre-order, each carrying
 *   the site it was assigned
 * @throws RC5051 when a `.suspend()` sits somewhere it cannot be revived
 *   from: inside a `.split()` fan-out (balanced or not), or inside a
 *   `.multicast()` path or `.dispatch()` target.
 *
 * @internal
 */
export function resolveSuspendSites(route: RouteDefinition): SuspendableStep[] {
  const found: SuspendableStep[] = [];
  const counter = { next: 0 };
  walk(route, route.steps, [], found, counter, {
    splitDepth: 0,
    sealed: false,
  });
  return found;
}

/**
 * Whether a route can reach a `.resume()`.
 *
 * A resume ingress needs the suspension runtime just as much as a
 * suspending route does: it verifies tokens against the signer and reads
 * the store. Without this a resume-only deployment (the common shape, since
 * the ingress is usually its own capability) starts clean and then refuses
 * every answer at request time, which is the failure the startup check
 * exists to move forward.
 *
 * @internal
 */
export function usesResume(route: RouteDefinition): boolean {
  return containsResume(route.steps);
}

/** @internal */
function containsResume(steps: ReadonlyArray<Step<Adapter>>): boolean {
  return steps.some(
    (step) =>
      step.operation === OperationType.RESUME ||
      nestedStepsOf(step).some((nested) => containsResume(nested.steps)),
  );
}

/**
 * Walk a step array in execution order, assigning positions and sites.
 *
 * @param tail - Steps that run after this array finishes, already flattened.
 *   A branch inherits the tail of the step that contains it, which is what
 *   makes a branch-local continuation span the main flow too.
 * @param scope - `splitDepth` counts `.split()` calls not yet balanced by an
 *   `.aggregate()`; `sealed` marks a sub-pipeline that never rejoins.
 *
 * @internal
 */
function walk(
  route: RouteDefinition,
  steps: ReadonlyArray<Step<Adapter>>,
  tail: ReadonlyArray<Step<Adapter>>,
  found: SuspendableStep[],
  counter: { next: number },
  scope: { splitDepth: number; sealed: boolean },
): void {
  let splitDepth = scope.splitDepth;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const position = counter.next++;
    const after = [...steps.slice(i + 1), ...tail];

    if (step.operation === OperationType.SPLIT) splitDepth++;
    else if (step.operation === OperationType.AGGREGATE && splitDepth > 0) {
      splitDepth--;
    }

    if (step.operation === OperationType.SUSPEND) {
      if (splitDepth > 0) {
        throw refuse(
          route.id,
          "inside a .split() fan-out, between the split and its .aggregate(). Reviving one parked child would mean tracking every outstanding sibling across restarts, which is a distributed coordination problem in disguise. Move the suspend out of the fan-out, or split the work into per-item child capabilities: each is then its own exchange and suspends independently",
        );
      }
      if (scope.sealed) {
        throw refuse(
          route.id,
          "inside a .multicast() path or .dispatch() target. Those exchanges are isolated side flows rather than the route's primary flow, so a resumed continuation would have nowhere to rejoin. Move the suspend onto the main flow, or onto a .choice() branch of it",
        );
      }
      const suspend = step as SuspendableStep;
      suspend.site = { position, continuation: after };
      found.push(suspend);
      continue;
    }

    const nested = nestedStepsOf(step);
    // Presence of the protocol, not emptiness of its answer: a
    // `.multicast()` with zero paths legitimately reports none, while a
    // step that never implemented the protocol reports none for the very
    // reason this check exists.
    if (!answersNestedSteps(step) && NESTING_OPERATIONS.has(step.operation)) {
      throw rcError("RC5003", undefined, {
        message:
          `Route "${route.id}" has a "${step.operation}" step that does not report its sub-pipelines, ` +
          `so the framework cannot see what is inside it. A step carrying sub-pipelines must implement ` +
          `the NESTED_STEPS protocol, and a wrapper around one must forward it.`,
      });
    }
    for (const branch of nested) {
      walk(route, branch.steps, branch.rejoins ? after : [], found, counter, {
        splitDepth,
        sealed: scope.sealed || !branch.rejoins,
      });
    }
  }
}

/**
 * Sub-pipelines a step carries, or none.
 *
 * @internal
 */
export function nestedStepsOf(step: Step<Adapter>): ReadonlyArray<NestedSteps> {
  const nesting = (step as Partial<NestingStep>)[NESTED_STEPS];
  return typeof nesting === "function" ? nesting.call(step as NestingStep) : [];
}

/**
 * Whether a step implements the {@link NESTED_STEPS} protocol at all.
 *
 * @internal
 */
function answersNestedSteps(step: Step<Adapter>): boolean {
  return typeof (step as Partial<NestingStep>)[NESTED_STEPS] === "function";
}

/**
 * Operations that MUST answer the {@link NESTED_STEPS} protocol.
 *
 * The protocol is opt-in, and an opt-in protocol fails silently: a step
 * that carries sub-pipelines but does not implement it makes everything
 * inside it invisible to this walk, so a `.suspend()` in there is refused
 * at runtime (after the approver was notified) rather than at build time,
 * and the route-scope cache and startup-runtime checks silently pass.
 *
 * Listing the operations that carry sub-pipelines turns that silent hole
 * into a loud one: a new nesting operation, or a wrapper that stops
 * forwarding, fails the build of any route using it rather than the resume
 * of one exchange.
 *
 * @internal
 */
const NESTING_OPERATIONS: ReadonlySet<OperationType> = new Set([
  OperationType.CHOICE,
  OperationType.MULTICAST,
  OperationType.DISPATCH,
]);

/** @internal */
function refuse(routeId: string, where: string): Error {
  return rcError("RC5051", undefined, {
    message: `Route "${routeId}" declares a .suspend() ${where}.`,
  });
}
