import type { RouteDefinition } from "../route.ts";
import type { Adapter, Step } from "../types.ts";

/**
 * Fields of {@link RouteDefinition} that are not pre-from chain positions.
 *
 * This list is the only place that says "this field is not part of the
 * chain". Everything else on the definition IS a chain position and must
 * declare, in {@link CHAIN_SURVIVAL}, whether it survives each kind of
 * detached run. Adding a field to `RouteDefinition` therefore fails the
 * build until it is either excluded here or given a policy, which is what
 * stops a future position from silently not applying.
 */
type NonChainField =
  | "id"
  | "sources"
  | "steps"
  | "consumer"
  | "discovery"
  | "suspendSteps"
  | "usesResume";

/** A pre-from filter chain position, as carried on the route definition. */
export type ChainField = Exclude<keyof RouteDefinition, NonChainField>;

/**
 * The two runs that re-enter a route partway down its pipeline.
 *
 * They are not variants of one thing. A `debounce` release is new work the
 * route held back, so the chain above it has not run for that exchange. A
 * `resume` is execution two of an exchange that entered the route once,
 * days earlier, and was admitted then.
 */
export type DetachedKind = "resume" | "debounce";

/** Whether one chain position survives each kind of detached run. */
interface ChainSurvival {
  readonly resume: boolean;
  readonly debounce: boolean;
  /** Why, in the terms the chain docs use. Kept beside the decision. */
  readonly why: string;
}

/**
 * Which chain positions apply to a run that re-enters partway down.
 *
 * Every position states its answer for both kinds rather than inheriting
 * one: a debounce release and a resume disagree about what "entered the
 * route" means for that exchange, so a position that is right for one can
 * be wrong for the other.
 *
 * One rule governs the resume column. A position that REFUSES work without
 * attempting it must not sit below the store transition, because the resume
 * claims its suspension before the continuation starts, so a refusal is
 * recorded as that suspension's terminal outcome and an approval is spent on
 * work that never ran. A position that BOUNDS work already underway is safe.
 * That is why `retry` and `timeout` are carried, `circuitBreaker` is not,
 * and `concurrency` is carried only in waiting form.
 */
const CHAIN_SURVIVAL: Readonly<Record<ChainField, ChainSurvival>> = {
  errorHandler: {
    resume: true,
    debounce: true,
    why: "The route still owns the exchange, and a revival failure has nowhere else to go: only the suspended route can notify and re-ask.",
  },
  preParseFilters: {
    resume: false,
    debounce: false,
    why: "authorize (#2). A principal restored from the store fails RC5043 by design (#355), so re-running it would refuse every resume. The answerer is authorized live at the resume ingress.",
  },
  postParseFilters: {
    resume: false,
    debounce: false,
    why: "cacheCheck (#9). Refused at build alongside a reachable suspend, because a park exits the pipeline this filter wraps.",
  },
  postFromFilters: {
    resume: false,
    debounce: false,
    why: "cacheStore (#10). The other half of the same refusal.",
  },
  throttle: {
    resume: false,
    debounce: false,
    why: "throttle (#5). It admits new work into the route; a parked exchange was admitted on execution one. Answer arrival is governed by the resume ingress route's own throttle.",
  },
  circuitBreaker: {
    resume: false,
    debounce: false,
    why: "circuitBreaker (#6). As a continuation copy it would fast-fail after the store transition is won, recording a failed terminal and spending the approval. Its correct home is the resume ingress route's chain, which wraps .resume() and so fast-fails above that transition.",
  },
  retry: {
    resume: true,
    debounce: false,
    why: "retry (#7). Retrying a continuation is the wanted behaviour and is safe against the transition: attempts run before any terminal outcome is recorded, so a retried continuation never spends an approval.",
  },
  timeout: {
    resume: true,
    debounce: false,
    why: "timeout (#8). Bounds execution two. Distinct from a suspension's ttl, which is a store-side expiry rather than a per-attempt deadline in this process.",
  },
  concurrency: {
    resume: true,
    debounce: false,
    why: "concurrency (#8.5). A bulkhead bounds simultaneous work in the route against a downstream, and a continuation is that work. Carried in waiting form only: a continuation runs after its suspension is claimed, so a refusal would spend an approval on work that never ran. It queues for the route's own semaphore, so the bound is shared with the ingress leg rather than escaped.",
  },
};

/**
 * The chain positions, as a value.
 *
 * `Object.keys` widens to `string[]`, so the assertion restores what the
 * `Record<ChainField, …>` above already guarantees: these keys are exactly
 * the chain fields, no more and no less.
 */
const CHAIN_FIELDS = Object.keys(CHAIN_SURVIVAL) as ChainField[];

/** What a detached run needs from the route definition it descends from. */
export type DetachedDefinition = Pick<RouteDefinition, ChainField | "steps">;

/** Chain positions whose absence is an empty array rather than undefined. */
const emptyChain = (): Pick<
  RouteDefinition,
  "preParseFilters" | "postParseFilters" | "postFromFilters"
> => ({
  preParseFilters: [],
  postParseFilters: [],
  postFromFilters: [],
});

/**
 * Build the definition a detached run executes under, position by position.
 *
 * Derived from {@link CHAIN_SURVIVAL} rather than written out, so a chain
 * position cannot be carried, or dropped, without saying so.
 *
 * @param source - The route's own definition
 * @param steps - The steps this run executes: a continuation, or the
 *   downstream a debounce release flows into
 * @param kind - Which detached run this is, which selects the policy
 *
 * @internal
 */
export function detachedDefinition(
  source: Pick<RouteDefinition, ChainField>,
  steps: ReadonlyArray<Step<Adapter>>,
  kind: DetachedKind,
): DetachedDefinition {
  const carried: Partial<Pick<RouteDefinition, ChainField>> = {};
  for (const field of CHAIN_FIELDS) {
    if (!CHAIN_SURVIVAL[field][kind]) continue;
    const value = source[field];
    if (value !== undefined) Object.assign(carried, { [field]: value });
  }
  return { ...emptyChain(), ...carried, steps: [...steps] };
}

/**
 * Whether a chain position survives a kind of detached run, and why.
 *
 * Exported for the tests that hold the documented table to the code.
 *
 * @internal
 */
export function chainSurvival(
  field: ChainField,
  kind: DetachedKind,
): { survives: boolean; why: string } {
  const policy = CHAIN_SURVIVAL[field];
  return { survives: policy[kind], why: policy.why };
}

/** Every chain position, for tests that assert the table is exhaustive. */
export function chainFields(): ReadonlyArray<ChainField> {
  return CHAIN_FIELDS;
}
