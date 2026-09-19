import type { RouteDefinition } from "../route.ts";
import type { Adapter, Step } from "../types.ts";

/**
 * Fields of {@link RouteDefinition} that are not pre-from chain positions.
 *
 * This list is the only place that says "this field is not part of the
 * chain". Every other field IS one, and must declare in
 * {@link CHAIN_SURVIVAL} whether it survives each kind of detached run, so
 * adding a field to `RouteDefinition` fails the build until it is either
 * excluded here or given a policy.
 *
 * The forcing is keyed by FIELD, and a field is not the same unit as a
 * chain position, so three cases sit outside it and still need a human:
 * `parse` (#3) is not on the definition at all, `input` (#4) lives under
 * `discovery`, and the three filter arrays each hold an arbitrary number of
 * positions that share one answer. A position added inside one of those
 * arrays inherits its neighbour's policy without breaking the build.
 */
type NonChainField =
  | "id"
  | "sources"
  | "steps"
  | "consumer"
  | "discovery"
  | "deferSteps"
  // Site bookkeeping like deferSteps: which steps could defer, not a
  // chain position. A detached run reaches those steps through its own
  // step array, and each host carries its site on the instance.
  | "reentrantDeferSteps"
  // Site bookkeeping too: where a park WOULD land, addressed by step
  // instance and by the run that is failing, never carried into one.
  | "errorPathSites"
  | "admissionSite"
  | "usesResume"
  // Metadata mirrored to sources (transport admission), not a chain
  // position: the authorize steps it describes already answer for
  // themselves under `preParseFilters`.
  | "requiresPrincipal"
  // Per-route LIFECYCLE, not per-exchange admission: it decides whether the
  // route runs at all, and is evaluated when the route starts rather than
  // when an exchange arrives. A detached run only happens inside a route
  // that is already running, so the predicate has nothing to say about it.
  | "enablement";

/** A pre-from filter chain position, as carried on the route definition. */
type ChainField = Exclude<keyof RouteDefinition, NonChainField>;

/**
 * The runs that re-enter a route partway down its pipeline.
 *
 * They are not variants of one thing, which is why each states its own
 * answer per position rather than inheriting a shared one.
 *
 * - `resume` is execution two of an exchange that entered the route once,
 *   possibly days earlier, and was admitted then. Its deferral is already
 *   claimed by the time the continuation runs.
 * - `debounce` is work the route deliberately held back. It never entered,
 *   so the chain above has not run for it at all.
 * - `errorChannel` is a failure pushed at an exchange that is not running,
 *   so that the route's own handler can react. It is not the exchange's
 *   work resuming; it is the route being told something about it.
 * - `admission` is execution two of an exchange that was parked from the
 *   error path BEFORE the route admitted it: an error handler answered a
 *   pre-from failure with `recovery.defer()`, so nothing in the body ran and
 *   the chain above it never finished. It is the only re-entry that is an
 *   admission rather than a continuation, which is why it is not a `resume`
 *   with a flag: the whole point of the column is that positions mean
 *   different things to it.
 */
export type DetachedKind = "resume" | "debounce" | "errorChannel" | "admission";

/** Whether one chain position survives one kind of detached run, and why. */
interface KindPolicy {
  readonly survives: boolean;
  /**
   * This run may not be REFUSED admission by the position: it queues
   * instead. Only meaningful where {@link KindPolicy.survives} is true.
   */
  readonly mustNotRefuse?: boolean;
  /** Stated per kind: the same position is off for different reasons. */
  readonly why: string;
}

/**
 * Which chain positions apply to a run that re-enters partway down.
 *
 * Every position answers for every kind. That exhaustiveness is enforced by
 * the type rather than by review: `ChainField` is derived from
 * `RouteDefinition`, so a new field breaks this record until it is
 * classified, and `Record<DetachedKind, KindPolicy>` breaks it again if a
 * new kind of detached run is added without deciding what that position
 * means for it.
 *
 * One rule governs the `resume` column. A position that REFUSES work
 * without attempting it must not sit below the store transition, because a
 * resume claims its deferral before the continuation starts, so a refusal
 * becomes that deferral's continuation result and spends an approval on work
 * that never ran. A position that BOUNDS work already underway is safe.
 *
 * `timeout` (#8) satisfies the rule only in the common case. It wraps the
 * bulkhead rather than sitting inside it, so on a route declaring both, a
 * deadline can elapse while the continuation is still queued for a slot and
 * fail work that never started. Narrowing that needs the chain order to
 * differ per kind, which the fixed-order contract in
 * `.standards/pre-from-filter-chain.md` does not currently allow.
 */
export const CHAIN_SURVIVAL: Readonly<
  Record<ChainField, Readonly<Record<DetachedKind, KindPolicy>>>
> = {
  errorHandler: {
    resume: {
      survives: true,
      why: "The route still owns the exchange, and a revival failure has nowhere else to go: only the deferred route can notify and re-ask.",
    },
    debounce: {
      survives: true,
      why: "A released exchange is the route's primary flow, so its failures belong to the route's handler like any other.",
    },
    errorChannel: {
      survives: true,
      why: "Reaching this handler IS the point of the re-entry. Without it there is nothing to push the failure at.",
    },
    admission: {
      survives: true,
      why: "The route still owns the exchange, and a continuation that fails where the original call failed has to reach the same handler, or a lend that did not satisfy the gate would strand the approver with no re-ask.",
    },
  },
  preParseFilters: {
    resume: {
      survives: false,
      why: "authorize (#2). A principal restored from the store fails RC5043 by design (#355), so re-running it would refuse every resume. The resuming principal is authorized live at the resume ingress.",
    },
    debounce: {
      survives: false,
      why: "authorize (#2). The released exchange was authorized when it arrived, before the route held it back.",
    },
    errorChannel: {
      survives: false,
      why: "authorize (#2). Nothing is being admitted: a failure is being reported about work that already ran.",
    },
    admission: {
      survives: true,
      why: "authorize (#2). This re-entry IS the admission the original call never completed, and the reason the resume column turns it off does not hold: the door's elevate hook supplied a LIVE principal, so RC5043 does not fire and the gate that refused gets to read the lent scope. Without it the lend would never be checked against the gate it was lent for.",
    },
  },
  postParseFilters: {
    resume: {
      survives: false,
      why: "cacheCheck (#9). Refused at build alongside a reachable defer, because a deferral exits the pipeline this filter wraps.",
    },
    debounce: {
      survives: false,
      why: "cacheCheck (#9). The release re-enters below it, so a check here would key work that is already in flight.",
    },
    errorChannel: {
      survives: false,
      why: "cacheCheck (#9). A failure report is not a cacheable request.",
    },
    admission: {
      survives: false,
      why: "cacheCheck (#9). Same as resume: refused at build alongside a reachable defer, and a check below the claim would key work that has already spent an approval.",
    },
  },
  postFromFilters: {
    resume: {
      survives: false,
      why: "cacheStore (#10). The other half of the same refusal.",
    },
    debounce: {
      survives: false,
      why: "cacheStore (#10). No key was taken on the way in, so there is nothing to store against.",
    },
    errorChannel: {
      survives: false,
      why: "cacheStore (#10). What a re-ask handler returns is a notification, not a cacheable output.",
    },
    admission: {
      survives: false,
      why: "cacheStore (#10). The other half of the cacheCheck refusal above: no key was taken on the way in, because the run that would have taken it never got past the chain.",
    },
  },
  throttle: {
    resume: {
      survives: false,
      why: "It admits new work into the route; a deferred exchange was admitted on execution one. Answer arrival is governed by the resume ingress route's own throttle.",
    },
    debounce: {
      survives: false,
      why: "The exchange was admitted on arrival; the hold was the route's own doing, not a second admission.",
    },
    errorChannel: {
      survives: false,
      why: "Rate-limiting a failure report would drop the report, not the load.",
    },
    admission: {
      survives: false,
      why: "It REFUSES work rather than bounding it, and this re-entry runs after the deferral is claimed, so a refusal here would record a failed continuation result and spend the approval. Unlike authorize, no hook can make that safe. Answer arrival is governed by the resume ingress route's own throttle.",
    },
  },
  circuitBreaker: {
    resume: {
      survives: false,
      why: "It fast-fails, and a continuation runs after the deferral is claimed, so a refusal here would record a failed continuation result and spend the approval. Its home is the resume ingress route's chain, which wraps .resume() and so refuses above that transition.",
    },
    debounce: {
      survives: false,
      why: "A released exchange has been held once already; fast-failing it discards work the route chose to keep.",
    },
    errorChannel: {
      survives: false,
      why: "An open breaker must not suppress the report of a failure.",
    },
    admission: {
      survives: false,
      why: "It fast-fails, which below the claim spends the approval on work that never ran. Same rule as resume, same home: the resume ingress route's own chain, which refuses above the transition.",
    },
  },
  retry: {
    resume: {
      survives: true,
      why: "Retrying a continuation is the wanted behaviour and is safe against the transition: attempts run before any continuation result is recorded, so a retried continuation never spends an approval.",
    },
    debounce: {
      survives: false,
      why: "A release is one settled decision by the debounce window, and re-running it would repeat side effects the window exists to collapse.",
    },
    errorChannel: {
      survives: false,
      why: "Re-running a handler would re-notify per attempt, which is the amplifier the exactly-once transitions exist to prevent.",
    },
    admission: {
      survives: true,
      why: "Same as resume: attempts run before any continuation result is recorded, so a retried continuation never spends an approval.",
    },
  },
  timeout: {
    resume: {
      survives: true,
      why: "Bounds execution two. Distinct from a deferral's ttl, which is a store-side expiry rather than a per-attempt deadline in this process.",
    },
    debounce: {
      survives: false,
      why: "The release is detached from the arrival whose deadline this describes.",
    },
    errorChannel: {
      survives: false,
      why: "A handler that runs long should finish reporting rather than be abandoned mid-notification.",
    },
    admission: {
      survives: true,
      why: "Bounds execution two, as it does for a resume. Distinct from the deferral's ttl, which is a store-side expiry rather than a per-attempt deadline in this process.",
    },
  },
  concurrency: {
    resume: {
      survives: true,
      mustNotRefuse: true,
      why: "A bulkhead bounds simultaneous work in the route against a downstream, and a continuation is that work. It queues for the route's own semaphore rather than refusing, because a refusal below the claim would spend an approval. The wait is unbounded in time, and a `key` selector that throws still refuses.",
    },
    debounce: {
      survives: false,
      why: "A bulkhead that can refuse would discard a release the window already decided to make.",
    },
    errorChannel: {
      survives: false,
      why: "A failure report must not queue behind the work it is reporting on.",
    },
    admission: {
      survives: true,
      mustNotRefuse: true,
      why: "Same as resume: a bulkhead bounds simultaneous work against a downstream and a continuation is that work, so it queues for the route's own semaphore rather than refusing, because a refusal below the claim would spend an approval.",
    },
  },
};

/**
 * The handler points core ships, as the survival table keys them.
 *
 * A literal union rather than `HandlerPoint`, which is declaration-merged: a
 * package outside core contributing a point cannot add a row to a constant
 * in core, so keying the table on the open type would make such a point
 * impossible to declare rather than merely unclassified. Core's four answer
 * here; a contributed point answers wherever it is consulted.
 */
type CorePoint = "admission" | "entry" | "error" | "exit";

/**
 * Which handler points apply to a run that re-enters partway down.
 *
 * A sibling of {@link CHAIN_SURVIVAL} rather than rows inside it, because
 * that table is keyed by `RouteDefinition` field and a handler point is not
 * one: it is registered on the context by someone who did not write the
 * route. The forcing that matters is kept: `Record<DetachedKind, KindPolicy>`
 * breaks this table when a new kind of detached run is added without saying
 * what each point means for it, which is the half a reader needs.
 */
export const POINT_SURVIVAL: Readonly<
  Record<CorePoint, Readonly<Record<DetachedKind, KindPolicy>>>
> = {
  admission: {
    resume: {
      survives: false,
      why: "The exchange was admitted on execution one, and the point sits above a chain that does not re-run for a continuation. A handler here also may not establish identity on a continuation at all, so there is nothing left for it to decide.",
    },
    debounce: {
      survives: false,
      why: "A released exchange was admitted when it arrived; the hold was the route's own doing and not a second admission.",
    },
    errorChannel: {
      survives: false,
      why: "Nothing is being admitted: a failure is being reported about work that already ran.",
    },
    admission: {
      survives: false,
      why: "This re-entry IS the admission the original call never completed, but the point that names it has already run: it ran on execution one, above the chain position that failed. Running it again would let a fresh mint discard the scopes a human lent through the door's elevate hook, which is the one thing the continuation exists to carry.",
    },
  },
  entry: {
    resume: {
      survives: false,
      why: "The continuation re-enters below the chain, at the step that parked, so the position it sits at is not reached. Its decoration is already on the exchange, restored from the record.",
    },
    debounce: {
      survives: false,
      why: "The release re-enters below the chain for the same reason the cache check does not run: the exchange passed this position when it arrived.",
    },
    errorChannel: {
      survives: false,
      why: "A failure report is not an entry: there is no route work about to start for the point to decorate or refuse.",
    },
    admission: {
      survives: true,
      why: "The chain above it is exactly what this re-entry re-runs, so the position IS reached, and a handler that decorated the first attempt must decorate the one that replaces it. It is told it is execution two, and a refusal here is safe for the same reason authorize's is: the door's own hooks ran before the claim.",
    },
  },
  error: {
    resume: {
      survives: true,
      why: "The same reason the route's own `.error()` survives: a continuation that fails has nowhere else to go, and the point is the outermost ring around it.",
    },
    debounce: {
      survives: true,
      why: "A released exchange is the route's primary flow, so its failures reach the same rings.",
    },
    errorChannel: {
      survives: true,
      why: "Reaching a handler IS the point of the re-entry, and this ring is consulted where the route's own gave up.",
    },
    admission: {
      survives: true,
      why: "A continuation that fails where the original call failed has to reach the same rings, or a lend that did not satisfy the gate would strand the approver with no re-ask.",
    },
  },
  exit: {
    resume: {
      survives: true,
      why: "The continuation produces the body the deferred call answers with, and that body leaves. A point that only ran on execution one would let a redaction be skipped by parking.",
    },
    debounce: {
      survives: true,
      why: "A release produces the route's output like any other run of it.",
    },
    errorChannel: {
      survives: false,
      why: "What a re-ask handler returns is a notification rather than the route's output, which is why `.output()` validation is skipped there too.",
    },
    admission: {
      survives: true,
      why: "Same as resume: the continuation is what produces the body that leaves.",
    },
  },
};

/** The chain positions, as a value. */
const CHAIN_FIELDS = Object.keys(CHAIN_SURVIVAL) as ChainField[];

/**
 * What a run executes under: the chain positions it carries, plus its own
 * steps. Every run has one, detached or not.
 *
 * `ExecutorDeps["definition"]` is this same type, so the set of fields the
 * executor consumes and the set the policy classifies cannot drift apart.
 */
export type ExecutedDefinition = Pick<RouteDefinition, ChainField | "steps">;

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
 * @param steps - The steps this run executes
 * @param kind - Which detached run this is, which selects the policy
 *
 * @internal
 */
export function detachedDefinition(
  source: Pick<RouteDefinition, ChainField>,
  steps: ReadonlyArray<Step<Adapter>>,
  kind: DetachedKind,
): ExecutedDefinition {
  const carried: Partial<Pick<RouteDefinition, ChainField>> = {};
  for (const field of CHAIN_FIELDS) {
    if (!CHAIN_SURVIVAL[field][kind].survives) continue;
    const value = source[field];
    if (value !== undefined) Object.assign(carried, { [field]: value });
  }
  return { ...emptyChain(), ...carried, steps: [...steps] };
}
