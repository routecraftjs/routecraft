import type { IdentityValue } from "./identity.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { rcError } from "../../error.ts";
import { OperationType } from "../../exchange.ts";
import { NESTED_STEPS, DEFERS, RESUMES } from "../../dsl-symbol.ts";
import type { Adapter, Step } from "../../types.ts";
import type { CraftContext } from "../../context.ts";
import type { RouteDefinition } from "../../route.ts";
import type { Deferred } from "./deferred.ts";
import type { ErrorPathRecord } from "./types.ts";

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
 * What a step says about deferring, through {@link DEFERS}.
 *
 * `"next-step"`: the step always defers, and a revival continues with the
 * step after it. `input` is the schema a resume payload is validated
 * against before the claim (`RC5049`), read back off the step at resume
 * because a schema cannot be stored with the record.
 *
 * `"this-step"`: the step may defer, and a revival runs it again with what
 * it stored (`ctx.defer.revived`). It names its `input` when it defers,
 * so the route cannot be asked for it and the step validates the payload.
 */
export type DeferDeclaration =
  | { readonly revival: "next-step"; readonly input?: StandardSchemaV1 }
  | { readonly revival: "this-step" };

/** A step that declares it defers. The kernel hands it `ctx.defer`. */
export interface DeferringStep extends Step<Adapter> {
  [DEFERS](): DeferDeclaration;
}

/**
 * A `.to()` / `.enrich()` adapter that may defer from inside `send` or
 * `fetch`. The step that carries it declares for it, and the adapter reads
 * `ctx.defer` off the context it is called with.
 */
export interface DeferringAdapter extends Adapter {
  [DEFERS](): { readonly revival: "this-step" };
}

/** A step that declares it resumes deferred exchanges. The kernel hands it `ctx.resume`. */
export interface ResumingStep extends Step<Adapter> {
  [RESUMES](): true;
}

/**
 * What a step declares through {@link DEFERS}, or `undefined`.
 *
 * @throws RC5003 when the declaration is not one of the two shapes
 * @internal
 */
export function deferDeclarationOf(
  step: Step<Adapter> | Adapter,
): DeferDeclaration | undefined {
  const declare = (step as { [DEFERS]?: () => DeferDeclaration | undefined })[
    DEFERS
  ];
  if (typeof declare !== "function") return undefined;
  const declared = declare.call(step);
  if (declared === undefined) return undefined;
  if (declared.revival !== "next-step" && declared.revival !== "this-step") {
    throw rcError("RC5003", undefined, {
      message: `A step's DEFERS declaration must be { revival: "next-step", input? } or { revival: "this-step" }; it returned ${JSON.stringify(declared)}.`,
    });
  }
  return declared;
}

/**
 * Whether a step declares {@link RESUMES}.
 *
 * @internal
 */
export function declaresResume(step: Step<Adapter>): boolean {
  const declare = (step as { [RESUMES]?: () => unknown })[RESUMES];
  return typeof declare === "function" && declare.call(step) === true;
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
 * Minted by a defer handle or by the error path, never built by hand: the
 * executor refuses a `defer` outcome whose request it did not mint
 * (`RC5032`).
 *
 * @internal
 */
export interface DeferTicket {
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
   * What the error path recorded about this park. Set only when the park
   * came from an error handler's `recovery.defer()`; absent for every
   * `.defer()` step and every re-entrant deferral.
   */
  readonly errorPath?: ErrorPathRecord;
  /**
   * Tell someone the exchange parked, awaited AFTER the record is written
   * and BEFORE the deferred event fires. See the ordering note on
   * `ErrorPathDeferRequest.notify`, which is where it comes from.
   */
  readonly notify?: (ack: Deferred) => void | Promise<void>;
  /**
   * What bounds {@link DeferTicket.notify}.
   *
   * Resolved by the executor rather than supplied by the handler, like
   * {@link DeferTicket.site}: the deferring route's intake signal widened by
   * an enclosing `.timeout()`, which is the same bound `runAuthorizer` gives
   * the resume `authorize` hook and for the same reason. Stop has to be in
   * it, because a route with no `.timeout()` could otherwise never interrupt
   * a hook that never settles, and an unsettled hook holds the step, which
   * holds `drain()`.
   */
  readonly notifySignal?: AbortSignal;
  /**
   * Closure state owned by the deferring step, persisted in the record's
   * `stepState` slot and handed back to a re-entrant step at revival. The
   * store never interprets it; the plain-JSON rule (`RC5042`) applies.
   */
  readonly stepState?: unknown;
}

const tickets = new WeakSet<object>();

/**
 * Mint the ticket a `defer` outcome carries.
 *
 * @internal
 */
export function mintDeferTicket(fields: DeferTicket): DeferTicket {
  const ticket = Object.freeze({ ...fields });
  tickets.add(ticket);
  return ticket;
}

/**
 * Whether a value is a ticket {@link mintDeferTicket} minted.
 *
 * @internal
 */
export function isDeferTicket(value: unknown): value is DeferTicket {
  return typeof value === "object" && value !== null && tickets.has(value);
}

/**
 * What the walk resolved for one step that declares {@link DEFERS}.
 *
 * A `"this-step"` step somewhere a deferral cannot be revived from keeps a
 * refusal rather than failing the build, because whether it ever defers is
 * dynamic; the refusal fires as `RC5051` on its first deferral.
 *
 * @internal
 */
export type DeclaredDeferSite =
  | {
      readonly kind: "site";
      readonly revival: DeferDeclaration["revival"];
      readonly site: DeferSite;
      /** The declared resume-payload schema of a `"next-step"` site. */
      readonly input?: StandardSchemaV1;
    }
  | {
      readonly kind: "refused";
      readonly revival: "this-step";
      readonly refusal: string;
    };

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
  /**
   * What selects this sub-pipeline, when something does: a `.choice()`
   * branch's predicate. It decides which branch shapes the body, so the
   * digest of the pipeline has to see it.
   */
  readonly selector?: IdentityValue;
}

/**
 * A step that carries nested sub-pipelines and reports them through
 * {@link NESTED_STEPS}, so the route's walks see inside it.
 */
export interface NestingStep extends Step<Adapter> {
  [NESTED_STEPS](): ReadonlyArray<NestedSteps>;
}

/**
 * Where an error-path park would land, for one step of the route.
 *
 * An error handler sits outside the step tree and has no position of its
 * own, so a park it raises has to borrow the position of whatever failed.
 * The walk resolves that for EVERY step rather than only for defer hosts,
 * because any step can fail; the two arms mirror the two answers the walk
 * already computes for a defer host, so an error-path park is refused from
 * exactly the positions a `DeferSignal` is.
 *
 * @internal
 */
export type ErrorPathSite =
  | { readonly kind: "site"; readonly site: DeferSite }
  /** Inside a `.split()` fan-out or a sealed side flow. Fires as RC5051. */
  | { readonly kind: "refused"; readonly refusal: string };

/**
 * Where an error-path park lands for a failure that did not come from the
 * route's step tree at all: the pre-from filter chain, and the framework's
 * own filter positions around the pipeline.
 *
 * Position 0 with the whole step list as its continuation, because nothing
 * in the body has run. Resuming it is ADMISSION rather than continuation,
 * which is why the record flags it: three positions run that a mid-pipeline
 * site never re-runs, and a restored principal is refused at `.authorize()`
 * by design, so such a park is completable only by a door that elevates.
 *
 * Shares position 0 with the first step's own error-path site, and the two
 * are told apart by the record's admission flag rather than by the number.
 * Giving admission a number outside the step range would read as an address
 * in a space where every other value is one.
 *
 * @internal
 */
export type AdmissionSite = DeferSite;

/**
 * What {@link resolveDeferSites} resolves for one route: the static
 * `.defer()` steps, the defer-capable `.to()` / `.enrich()` steps that
 * were assigned a re-entrant site, and where an error-path park would land
 * from each step. The lists are kept apart because they answer different
 * questions: static sites are what the startup runtime check (`RC5052`) and
 * the route-scope cache refusal key on, re-entrant sites only say a step MAY
 * defer at runtime, and error-path sites say nothing about whether the route
 * defers at all, only where a park would go if a handler asked for one.
 *
 * @internal
 */
export interface ResolvedDeferSites {
  /** Every step that declares `DEFERS`, by the instance the executor runs. */
  declared: Map<Step<Adapter>, DeclaredDeferSite>;
  /** The route can reach a step that declares `RESUMES`. */
  resumes: boolean;
  /**
   * Keyed by step INSTANCE rather than by position, because that is what the
   * executor holds when a step fails. Positions are derivable from the site
   * inside; the reverse lookup is not.
   */
  errorPathSites: Map<Step<Adapter>, ErrorPathSite>;
  admissionSite: AdmissionSite;
}

/**
 * Whether a built route can raise a durable deferral: statically (a
 * declared `.defer()`), at runtime (a defer-capable step that MAY defer),
 * or from the error path (an error-slot hook that applies to this route and
 * may answer with `recovery.defer()`). The predicate transports key on to
 * advertise a `Deferred` acknowledgment arm, owned here next to the fields
 * it reads so a new way for a route to defer updates every consumer in one
 * edit.
 *
 * @param context - The context the route is registered in, when the caller
 *   has one. An error hook declared with `mayDefer` can park a route that
 *   declares no defer site of its own, so a transport that omits this
 *   under-advertises every route such a hook selects. The hook counts only
 *   for the routes its `routes` and `tags` select, as at dispatch: a hook
 *   aimed at one route leaves every other route's answer alone. Optional
 *   rather than required because the two shipped callers differ: the MCP
 *   source holds the context, and a caller reasoning about a definition
 *   alone gets the definition's own answer.
 */
export function routeCanDefer(
  definition: RouteDefinition,
  context?: Pick<CraftContext, "hasDeferringErrorHook">,
): boolean {
  for (const declared of resolvedSitesOf(definition)?.declared.values() ?? []) {
    if (declared.kind === "site") return true;
  }
  return context?.hasDeferringErrorHook(definition) === true;
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
    declared: new Map(),
    resumes: containsResume(route.steps),
    errorPathSites: new Map(),
    // Nested steps are reached through branch outcomes, so the top level is the whole body.
    admissionSite: { position: 0, continuation: route.steps },
  };
  const counter = { next: 0 };
  walk(route, route.steps, [], found, counter, {
    splitDepth: 0,
    sealed: false,
  });
  return found;
}

/**
 * Resolve a definition's park sites and write every one of them onto it.
 *
 * The single place that answers "what did the walk decide about this route",
 * because there are two ways a definition reaches a context: built by
 * `craft().build()`, or handed over hand-written. Both need the same five
 * answers, and copying four of them at one site is a silent failure: the
 * startup deferral-runtime check reads `deferSteps` (`context.ts`), and a
 * revival finds its static parked site by walking the same list
 * (`kernel/continuation/resume.ts`), so a definition missing it starts without a
 * runtime and then cannot be resumed.
 *
 * Callers guard on whether the work is already done; this always does it.
 *
 * Every field is overwritten with the walk's answer, never merged: a
 * hand-written definition can arrive carrying `deferSteps` its own steps do
 * not support, which would have startup demand a deferral runtime for a
 * route that cannot park. Empty answers leave the field absent so the common
 * case stays cheap to ask about.
 *
 * @internal
 */
export function applyResolvedSites(definition: RouteDefinition): void {
  const sites = resolveDeferSites(definition);
  resolved.set(definition, sites);
  definition.errorPathSites = sites.errorPathSites;
  definition.admissionSite = sites.admissionSite;
}

const resolved = new WeakMap<RouteDefinition, ResolvedDeferSites>();

/**
 * What {@link applyResolvedSites} resolved for a definition, or `undefined`
 * for one that never went through it.
 *
 * @internal
 */
export function resolvedSitesOf(
  definition: RouteDefinition,
): ResolvedDeferSites | undefined {
  return resolved.get(definition);
}

/**
 * Whether the route declares a site that always defers (a `"next-step"`
 * declaration, the shipped `.defer()` included). Startup demands a
 * continuations provider for it (`RC5052`), and a route-scope cache is
 * refused beside it.
 *
 * @internal
 */
export function alwaysDefers(definition: RouteDefinition): boolean {
  for (const declared of resolvedSitesOf(definition)?.declared.values() ?? []) {
    if (declared.kind === "site" && declared.revival === "next-step") {
      return true;
    }
  }
  return false;
}

/**
 * Whether a route can reach a step that declares `RESUMES`.
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
  return resolvedSitesOf(route)?.resumes ?? containsResume(route.steps);
}

/** @internal */
function containsResume(steps: ReadonlyArray<Step<Adapter>>): boolean {
  return steps.some(
    (step) =>
      declaresResume(step) ||
      nestedStepsOf(step).some((nested) => containsResume(nested.steps)),
  );
}

/**
 * Walk a step array in execution order, assigning positions and sites.
 *
 * Every step gets an error-path verdict, not just the defer hosts, because
 * an error-path park borrows whichever step threw. Its continuation re-enters
 * that step, like a re-entrant site, since it failed part-way through its
 * work. A `.split()` step's own park is refused along with everything inside
 * the fan-out it opens. A defer-capable host in a refused position gets a
 * stored refusal rather than a build failure (see {@link resolveDeferSites}).
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

    // After the adjustment above, so a `.split()` step's own park is refused too.
    found.errorPathSites.set(
      step,
      splitDepth > 0
        ? {
            kind: "refused",
            refusal: unrevivablePosition(route.id, "split", "raised"),
          }
        : scope.sealed
          ? {
              kind: "refused",
              refusal: unrevivablePosition(route.id, "sealed", "raised"),
            }
          : {
              kind: "site",
              site: {
                position,
                continuation: [step, ...after],
                reentrant: true,
              },
            },
    );

    const declaration = deferDeclarationOf(step);
    if (declaration?.revival === "next-step") {
      if (splitDepth > 0) {
        throw refuse(route.id, "split");
      }
      if (scope.sealed) {
        throw refuse(route.id, "sealed");
      }
      found.declared.set(step, {
        kind: "site",
        revival: "next-step",
        site: { position, continuation: after },
        ...(declaration.input !== undefined
          ? { input: declaration.input }
          : {}),
      });
      continue;
    }
    if (declaration?.revival === "this-step") {
      found.declared.set(
        step,
        splitDepth > 0
          ? {
              kind: "refused",
              revival: "this-step",
              refusal: unrevivablePosition(route.id, "split", "raised"),
            }
          : scope.sealed
            ? {
                kind: "refused",
                revival: "this-step",
                refusal: unrevivablePosition(route.id, "sealed", "raised"),
              }
            : {
                kind: "site",
                revival: "this-step",
                site: {
                  position,
                  continuation: [step, ...after],
                  reentrant: true,
                },
              },
      );
    }

    const nested = nestedStepsOf(step);
    // Presence of the protocol, not emptiness: a `.multicast()` may have zero paths.
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
