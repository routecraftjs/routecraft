import type { StandardSchemaV1 } from "@standard-schema/spec";
import { BRAND, isBranded, setBrand } from "../brand.ts";
import { rcError } from "../error.ts";
import { OperationType } from "../exchange.ts";
import { NESTED_STEPS, DEFER_HOST } from "../dsl-symbol.ts";
import type { Adapter, Step } from "../types.ts";
import type { RouteDefinition } from "../route.ts";

/**
 * Where a `.defer()` sits in a route, and what runs when it is resumed.
 *
 * Resolved once at `craft().build()` time and stored on the route
 * definition, for one reason: execution two happens in a different process,
 * so the continuation cannot be a closure captured at defer time. It has
 * to be re-derivable from the route definition alone, and a site is exactly
 * that derivation.
 */
export interface DeferSite {
  /**
   * Stable address of the deferring step within the route.
   *
   * The index of the step in a pre-order walk of the route's step tree, not
   * an index into `definition.steps`: a defer inside a `.choice()` branch
   * is a real position that a flat index cannot name. Two processes running
   * the same route source derive the same numbers, which is all the address
   * has to guarantee. The record's `position` field carries it, and
   * `position + 1` onward is {@link DeferSite.continuation}, except for a
   * re-entrant site, whose continuation starts at `position` itself.
   */
  readonly position: number;
  /**
   * The steps that run on resume, flattened in execution order.
   *
   * For a defer on the main flow this is simply the steps after it. For a
   * defer inside a `.choice()` branch it is the rest of that branch
   * followed by the steps after the choice, which is the same sequence the
   * executor would have run had the exchange never deferred (a matched branch
   * rejoins the main flow).
   *
   * For a re-entrant site the continuation additionally INCLUDES the
   * deferring step itself at its head, because the step must re-run to
   * finish the work it deferred in the middle of. That head is therefore also
   * covered by the continuation hash: editing a defer-capable step's own
   * definition (an inline agent's options, say) invalidates its deferred
   * exchanges, which is correct because that definition is what resumes.
   */
  readonly continuation: ReadonlyArray<Step<Adapter>>;
  /**
   * Resume re-enters the deferring step itself rather than the step after
   * it. Set on sites assigned to defer-capable `.to()` / `.enrich()`
   * steps; absent on static `.defer()` sites.
   *
   * Two consequences at revival, both deliberate: the payload is NOT
   * validated against a live schema (the schema the step raised at defer
   * time lives in its own code and cannot be read back off the route, so
   * `RC5049` never fires for a re-entrant site and the step is the
   * validator), and the stored schema descriptor is compared against
   * itself, so a changed schema cannot be detected. Both are the same
   * residue class as "the hash covers step definitions, never the behaviour
   * of what the tail calls".
   */
  readonly reentrant?: boolean;
}

/**
 * Mark an adapter as able to raise a durable deferral from inside its own
 * execution (by throwing a `DeferSignal` from `fetch` / `send`). The
 * defer-site walk assigns `.to()` / `.enrich()` steps carrying a marked
 * adapter a re-entrant {@link DeferSite}.
 *
 * Core owns the brand; a consumer package (the agent tier is the shipped
 * case) marks its adapter with this helper and never mints its own symbol.
 */
export function markDeferCapable(adapter: Adapter): void {
  setBrand(adapter, BRAND.DeferCapable);
}

/**
 * Whether an adapter was marked with {@link markDeferCapable}.
 *
 * @internal
 */
export function isDeferCapable(adapter: Adapter): boolean {
  return isBranded(adapter, BRAND.DeferCapable);
}

/**
 * A `.to()` / `.enrich()` step that can host a re-entrant defer site.
 * The walk stores its verdict on the hosting instance, because that
 * instance's `execute` is where the defer signal is converted (before any
 * step-scope wrapper can observe the throw and, say, retry the step).
 *
 * @internal
 */
export interface DeferCapableStep extends Step<Adapter> {
  /** Assigned by {@link resolveDeferSites} when the step sits on the primary flow. */
  deferSite?: DeferSite;
  /**
   * Why no site was assigned, when the step sits somewhere a durable deferral
   * cannot be revived from (inside a `.split()` fan-out, or a
   * `.multicast()` path / `.dispatch()` target). Deferability of a
   * capable step is dynamic, so the refusal cannot fail the build the way a
   * static `.defer()` does; it fails the first actual deferral instead,
   * with this message, as `RC5051`.
   */
  deferRefusal?: string;
  /** Identity through wrappers: the instance the walk stores the site on. */
  [DEFER_HOST](): DeferCapableStep | undefined;
}

/**
 * Resolve the defer-capable host of a step, looking through step-scope
 * wrappers (which forward {@link DEFER_HOST} like they forward
 * {@link NESTED_STEPS}). Returns undefined for steps that cannot host a
 * re-entrant site, which is every step other than `.to()` / `.enrich()`
 * (and a wrapper around one of those).
 *
 * @internal
 */
export function deferHostOf(step: Step<Adapter>): DeferCapableStep | undefined {
  const resolve = (step as Partial<DeferCapableStep>)[DEFER_HOST];
  return typeof resolve === "function"
    ? resolve.call(step as DeferCapableStep)
    : undefined;
}

/**
 * What a `defer` outcome hands the executor.
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
export interface DeferRequest {
  /**
   * Live schema the eventual resume payload is validated against, when the site
   * declared one. Absent defers with no ingress validation, which is the
   * click-yes case: the route's own continuation is then the only reader of
   * whatever arrives.
   */
  readonly schema?: StandardSchemaV1;
  /** Resolved TTL in milliseconds, when one was declared. */
  readonly expiresInMs?: number;
  /**
   * Whatever the deferring step attached at deferral. Persisted verbatim and
   * handed to the resume route's `authorize` hook; never interpreted here.
   */
  readonly meta?: unknown;
  /**
   * Identity of the call this deferral belongs to, when the deferring step
   * mints one credential per call. Persisted as the record's `callBinding`
   * and carried as the token's `sub` claim.
   */
  readonly callBinding?: string;
  /** Where this defer sits, and what runs on resume. */
  readonly site: DeferSite;
  /**
   * Closure state owned by the deferring step, persisted in the record's
   * `stepState` slot and handed back to a re-entrant step at revival. The
   * store never interprets it; the plain-JSON rule (`RC5042`) applies.
   */
  readonly stepState?: unknown;
}

/**
 * A step that can defer the exchange. Implemented by the `.defer()` step;
 * declared here so the walk can recognise one without importing the
 * operation (which imports this module back).
 *
 * @internal
 */
export interface DeferrableStep extends Step<Adapter> {
  readonly operation: OperationType.DEFER;
  /**
   * The live resume-payload schema, when the site declared one. Read back
   * off the step at resume time to validate the submitted payload, because a
   * Standard Schema cannot be persisted with the record.
   */
  readonly schema?: StandardSchemaV1;
  /** Assigned by {@link resolveDeferSites}. Absent means the step is not reachable from a built route. */
  site?: DeferSite;
}

/**
 * One nested sub-pipeline of a step, as reported through
 * {@link NESTED_STEPS}.
 *
 * `rejoins` is the load-bearing field. A `.choice()` branch flows back into
 * the main pipeline when it matches, so a defer inside one has a
 * well-defined continuation that spans the branch tail and the main tail. A
 * `.multicast()` path or a `.dispatch()` target runs as an isolated nested
 * pipeline whose exchange is not the route's primary flow, so there is no
 * such continuation and a defer inside one is refused.
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
 * What {@link resolveDeferSites} resolves for one route: the static
 * `.defer()` steps, and the defer-capable `.to()` / `.enrich()` steps
 * that were assigned a re-entrant site. The two lists are kept apart
 * because they answer different questions: static sites are what the
 * startup runtime check (`RC5052`) and the route-scope cache refusal key
 * on, while re-entrant sites only say a step MAY defer at runtime.
 *
 * @internal
 */
export interface ResolvedDeferSites {
  deferSteps: DeferrableStep[];
  reentrantDeferSteps: DeferCapableStep[];
}

/**
 * Whether a built route can raise a durable deferral: statically (a
 * declared `.defer()`) or at runtime (a defer-capable step that MAY
 * deferral). The predicate transports key on to advertise a `Deferred`
 * acknowledgment arm, owned here next to the fields it reads so a new way
 * for a route to defer updates every consumer in one edit.
 */
export function routeCanDefer(definition: RouteDefinition): boolean {
  return (
    (definition.deferSteps?.length ?? 0) > 0 ||
    (definition.reentrantDeferSteps?.length ?? 0) > 0
  );
}

/**
 * Resolve every defer site in a route, refusing the positions where a
 * durable deferral cannot be revived.
 *
 * Runs at build time so an incoherent route fails on the deploy that
 * introduced it rather than on the first large payout. Assigns each
 * deferring step its {@link DeferSite} as a side effect, because the
 * step is what the executor holds when the outcome comes back.
 *
 * A static `.defer()` in an unrevivable position fails the build; a
 * defer-capable step there gets a stored refusal instead, because whether
 * it ever defers is dynamic, and refusing the build would reject every
 * route that fans an agent out over a split whether or not any tool defers.
 * The refusal carries the same explanation and fires as `RC5051` on the
 * first actual deferral.
 *
 * @param route - A finalised route definition
 * @returns The static defer steps and the re-entrant hosts, in pre-order,
 *   each carrying the site (or refusal) it was assigned
 * @throws RC5051 when a `.defer()` sits somewhere it cannot be revived
 *   from: inside a `.split()` fan-out (balanced or not), or inside a
 *   `.multicast()` path or `.dispatch()` target.
 *
 * @internal
 */
export function resolveDeferSites(route: RouteDefinition): ResolvedDeferSites {
  const found: ResolvedDeferSites = {
    deferSteps: [],
    reentrantDeferSteps: [],
  };
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
 * A resume ingress needs the deferral runtime just as much as a
 * deferring route does: it verifies tokens against the signer and reads
 * the store. Without this a resume-only deployment (the common shape, since
 * the ingress is usually its own capability) starts clean and then refuses
 * every resume at request time, which is the failure the startup check
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
  found: ResolvedDeferSites,
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

    if (step.operation === OperationType.DEFER) {
      if (splitDepth > 0) {
        throw refuse(route.id, "split");
      }
      if (scope.sealed) {
        throw refuse(route.id, "sealed");
      }
      const defer = step as DeferrableStep;
      defer.site = { position, continuation: after };
      found.deferSteps.push(defer);
      continue;
    }

    const host = deferHostOf(step);
    if (host && isDeferCapable(step.adapter)) {
      // The same positions a static `.defer()` is refused from, with the
      // same reasons, but recorded rather than thrown: whether a capable
      // step ever defers is dynamic, so the refusal fires as RC5051 on
      // the first actual deferral instead of failing every route that
      // merely places an agent inside a fan-out or a side flow.
      // A rebuilt walk starts every host clean so a stale field from an
      // earlier resolution can never outrank the fresh one.
      delete host.deferRefusal;
      delete host.deferSite;
      if (splitDepth > 0) {
        host.deferRefusal = unrevivablePosition(route.id, "split", "raised");
      } else if (scope.sealed) {
        host.deferRefusal = unrevivablePosition(route.id, "sealed", "raised");
      } else {
        // The step itself heads the continuation: a re-entrant resume runs
        // the step again to finish the work it deferred in the middle of.
        host.deferSite = {
          position,
          continuation: [step, ...after],
          reentrant: true,
        };
        found.reentrantDeferSteps.push(host);
      }
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
 * inside it invisible to this walk, so a `.defer()` in there is refused
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
function refuse(routeId: string, position: "split" | "sealed"): Error {
  return rcError("RC5051", undefined, {
    message: unrevivablePosition(routeId, position, "declares"),
  });
}

/**
 * One fact, two raisers: the positions a durable deferral cannot be
 * revived from, phrased for whichever site reports it. The build-time throw
 * (a static `.defer()`) and the recorded runtime refusal (a
 * defer-capable step, RC5051 on its first actual deferral) must never
 * drift into telling users different stories about the same constraint, so
 * both render from here.
 *
 * @internal
 */
function unrevivablePosition(
  routeId: string,
  position: "split" | "sealed",
  form: "declares" | "raised",
): string {
  const subject =
    form === "declares" ? "declares a .defer()" : "raised a durable deferral";
  const mover = form === "declares" ? "the defer" : "the deferring step";
  const body =
    position === "split"
      ? `inside a .split() fan-out, between the split and its .aggregate(). Reviving one deferred child would mean tracking every outstanding sibling across restarts, which is a distributed coordination problem in disguise. Move ${mover} out of the fan-out, or split the work into per-item child capabilities: each is then its own exchange and defers independently.`
      : `inside a .multicast() path or .dispatch() target. Those exchanges are isolated side flows rather than the route's primary flow, so a resumed continuation would have nowhere to rejoin. Move ${mover} onto the main flow, or onto a .choice() branch of it.`;
  return `Route "${routeId}" ${subject} ${body}`;
}
