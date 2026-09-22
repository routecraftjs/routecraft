/** Round two protocol. No transport, operation or persistence implementation lives here. */
export class Fault extends Error {
  readonly secondary: Fault[] = [];
  constructor(
    readonly plugin: string,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`[${plugin}] ${code}: ${message}`, options);
  }
}
export function fault(plugin: string, code: string, error: unknown): Fault {
  return error instanceof Fault
    ? error
    : new Fault(plugin, code, String(error), { cause: error });
}
declare const PORT: unique symbol;
export interface Port<T> {
  readonly key: symbol;
  readonly name: string;
  readonly [PORT]?: (x: T) => T;
}
export type AnyPort = Pick<Port<never>, "key" | "name">;
export function port<T>(name: string): Port<T> {
  return Object.freeze({ key: Symbol(name), name });
}
/**
 * The core exchange carries no identity. Who the work is for is a header
 * owned by an auth plugin, which is the only place that can tell a principal
 * it minted from one a step wrote or one that came back from storage.
 */
export interface Exchange<B = unknown, H = Record<string, unknown>> {
  readonly id: string;
  readonly routeId: string;
  body: B;
  headers: H;
}
/** The plain-JSON form an exchange takes while parked. Only this crosses the store. */
export interface SerializedExchange {
  readonly id: string;
  readonly routeId: string;
  readonly body: unknown;
  readonly headers: Record<string, unknown>;
}
export type DetachedKind = "resume" | "debounce" | "errorChannel";
export type RunKind = "normal" | DetachedKind;
export type Survival = Readonly<Record<RunKind, boolean>>;
export const allRuns: Survival = Object.freeze({
  normal: true,
  resume: true,
  debounce: true,
  errorChannel: true,
});
/**
 * What a step asks for when it parks. The continuation id is not chosen here:
 * it is minted per exchange as `{exchangeId}#{sequence}`, so one route can
 * park any number of exchanges at once and a step can learn the id before it
 * defers, through the deferral facet, to embed it in a notification.
 */
export interface DeferRequest {
  readonly name: string;
  readonly reason: string;
  readonly reenter?: boolean;
  /** Milliseconds until the parked exchange comes due. Absent means never. */
  readonly ttl?: number;
  /**
   * State the deferring step owns across the wait, handed back to it as
   * `StepContext.stepState` on the resume and nowhere else: it is runtime
   * context for one re-entrant execution, never exchange state, so a second
   * defer does not carry it unless the step asks again.
   */
  readonly state?: unknown;
}
/** Headers the kernel writes on a parked and a resumed exchange. Exchange state, so they survive a second defer. */
export const DEFERRAL_SEQUENCE = "routecraft.deferral.sequence";
export const DEFERRAL_RESULT = "routecraft.deferral.result";
export const DEFERRAL_RESUMED_AT = "routecraft.deferral.resumedAt";
/**
 * The resume ingress, recorded as DATA. The kernel runs the admitted ingress
 * headers through the persistence codec before writing them here, so nothing
 * live (a branded principal, a signal) reaches the continuation: an auth
 * plugin reads who resumed off this header and finds a shape, never a
 * credential. The continuation keeps the headers it parked with.
 */
export const DEFERRAL_INGRESS = "routecraft.deferral.ingress";
export type StepOutcome<B = unknown> =
  | { kind: "continue" | "complete"; exchange: Exchange<B> }
  | { kind: "drop" }
  | { kind: "branch"; exchange: Exchange<B>; steps: readonly Step[] }
  | { kind: "fanOut"; exchanges: readonly Exchange<B>[] }
  | { kind: "defer"; exchange: Exchange<B>; request: DeferRequest };
export interface Step {
  readonly id: string;
  readonly owner: string;
  readonly version: string;
  /** Public discoverable children. Returned branches must reference this compiled graph. */
  readonly children?: readonly Step[];
  /**
   * Values that identify this step's behaviour beyond its id: the user's
   * callable for a transform, the option bag for an adapter. Folded into the
   * tail hash a parked exchange is checked against through a recursive
   * projection (functions by verbatim source text at any depth, plain data
   * canonically, anything else as an opaque marker), so an approval cannot
   * authorise steps that were edited under it, a nested callback included.
   */
  readonly source?: readonly unknown[];
  execute(
    exchange: Exchange,
    context: StepContext,
  ): StepOutcome | Promise<StepOutcome>;
}
export interface PathResult {
  readonly failed: boolean;
  readonly dropped: boolean;
  readonly error?: Fault;
  readonly aborted?: boolean;
}
export interface ServiceLookup {
  require<T>(contract: Port<T>): T;
}
export interface StepContext extends ServiceLookup {
  readonly signal: AbortSignal;
  readonly attemptId: string;
  readonly kind: RunKind;
  /** Present only on the step that parked, on the run that resumes it: the `state` it handed to its defer request. */
  readonly stepState?: unknown;
  takePending(predicate: (exchange: Exchange) => boolean): Exchange[];
  runPaths(
    paths: readonly { steps: readonly Step[]; exchange: Exchange }[],
  ): Promise<void>;
  runPath(path: {
    steps: readonly Step[];
    exchange: Exchange;
  }): Promise<PathResult>;
  captureDownstream(
    kind?: "debounce" | "errorChannel",
  ): (exchange: Exchange) => Promise<RunResult>;
  /** A synchronous effect fence; async IO must ALSO honour signal. Not a sandbox. */
  commit<T>(effect: () => T): T;
  /** Streaming completion and detached work remain owned by the route during drain. */
  track(work: Promise<unknown>): void;
  dispatch(routeId: string, exchange: Exchange): Promise<RunResult>;
  invoke<K extends keyof HandlerPoints>(
    point: K,
    exchange: Exchange,
  ): Promise<Exchange | null>;
}
export interface RunResult {
  /** `duplicate` is a second resume of a continuation that already ran: nothing re-executed, `outcome` says how the first one ended. */
  readonly status:
    "completed" | "dropped" | "deferred" | "refused" | "duplicate";
  readonly exchanges: readonly Exchange[];
  readonly deferrals: readonly string[];
  /** The cached outcome behind a `duplicate`. Absent when the first resume has not recorded one: still running, or died mid-continuation. */
  readonly outcome?: SerializedOutcome;
}
/**
 * One segment of the path a parked exchange still has to run: a suffix of a
 * declared step list, the route's own (`list: null`) or the children of the
 * named step. A pending path is always a concatenation of such suffixes,
 * because a branch injects a whole child list ahead of what was already
 * pending. Frames address the LIVE graph, so the resume rebuilds the tail
 * from the route as compiled today and compares that against the hash the
 * approval was taken over; an instruction appended after the defer point is
 * therefore in the comparison, not skipped.
 */
export interface Frame {
  readonly list: string | null;
  readonly from: number;
}
export interface Continuation {
  readonly codec: 2;
  readonly routeId: string;
  /** The step that parked the exchange. */
  readonly site: string;
  readonly frames: readonly Frame[];
  /** Hash of the step definitions after the defer point, callables by source text at any depth. Nothing else. */
  readonly tail: string;
  readonly exchange: SerializedExchange;
  readonly parkedAt: number;
  readonly expiresAt?: number;
  /** Opaque to the store; subject to the persistence codec like every other slot. */
  readonly stepState?: unknown;
}
export interface SerializedOutcome {
  readonly status: RunResult["status"] | "failed";
  /** The terminal exchanges that were persistable. A completion with an unpersistable body is still a completion. */
  readonly exchanges: readonly SerializedExchange[];
  /** How many terminal exchanges could not be cached. */
  readonly omitted?: number;
  readonly error?: string;
}
export interface ContinuationRecord {
  readonly state: "waiting" | "resumed" | "expired" | "denied";
  readonly continuation: Continuation;
  /** Epoch millis of an outstanding notification claim. The record stays waiting and is not resumable while it holds. */
  readonly claimedAt?: number;
  readonly resumedAt?: number;
  /** When the record stopped waiting. Retention measures from here, never from `parkedAt`. */
  readonly settledAt?: number;
  readonly reason?: string;
  /** Cached reply for a duplicate resume. Absent between markResumed and recordOutcome. */
  readonly outcome?: SerializedOutcome;
}
export type CasResult = "won" | "lost";
export interface ExpiredEntry {
  readonly id: string;
  readonly routeId: string;
  readonly expiresAt: number;
}
/** Keyset cursor over `(expiresAt, id)`: a page starts strictly after it, whatever became of the records before. */
export type ScanCursor = Pick<ExpiredEntry, "id" | "expiresAt">;
/**
 * Semantic persistence boundary, not a generic KV contract in the executor.
 *
 * Two mechanisms, deliberately asymmetric, because they protect different
 * things. A RESUME is `markResumed`, a compare-and-swap out of `waiting` taken
 * before the continuation runs: exactly one caller wins, a second is told
 * `duplicate` and handed the cached outcome, and a holder that dies mid-run
 * leaves residue that `resumedWithoutOutcome` reports and nothing re-runs,
 * because a half-run continuation may have half-happened side effects. A
 * NOTIFICATION is `claimExpiry`, a claim over a record that stays waiting
 * and excludes a resume while it holds: a holder that dies mid-delivery is
 * healed by `releaseClaims` once the lease elapses and the next sweep
 * redelivers, because re-sending a nag is safe. Expiry and denial both settle
 * through that claim. Modelling the resume as the lease re-runs
 * continuations; modelling the notification as the CAS loses nags. Both
 * mistakes have been made here.
 */
export interface ContinuationStore {
  /** Refuses a second continuation under one id. */
  create(id: string, continuation: Continuation): Promise<void>;
  get(id: string): Promise<ContinuationRecord | undefined>;
  /** Wins only against a waiting, UNCLAIMED record. */
  markResumed(id: string, at: number): Promise<CasResult>;
  recordOutcome(id: string, outcome: SerializedOutcome): Promise<void>;
  claimExpiry(id: string, at: number): Promise<CasResult>;
  /** Settle a claimed record as expired, stamping `settledAt`. */
  markExpired(id: string, at: number): Promise<CasResult>;
  /** Settle a claimed record as denied, stamping `settledAt` and the reason. */
  markDenied(id: string, at: number, reason: string): Promise<CasResult>;
  releaseClaims(before: number): Promise<number>;
  /** Waiting, unclaimed, due at or before `now`; ordered `(expiresAt, id)`, one page, strictly after `after`. */
  findExpired(
    now: number,
    limit: number,
    after?: ScanCursor,
  ): Promise<ExpiredEntry[]>;
  /** Resumed records with no cached outcome: a process died mid-continuation. Report, never re-run. */
  resumedWithoutOutcome(limit?: number): Promise<string[]>;
  /** Compare-and-swap the step state of a waiting, unclaimed record; `expected` is the fingerprint of what the caller read. */
  replaceStepState(
    id: string,
    expected: string,
    stepState: unknown,
  ): Promise<CasResult>;
  /** Count and oldest `parkedAt` of the records still waiting. */
  pending(): Promise<{ readonly count: number; readonly oldest?: number }>;
  /** Delete settled records whose `settledAt` is before `before`. Waiting records are never touched. */
  purgeSettled(before: number): Promise<number>;
}
export const CONTINUATIONS = port<ContinuationStore>(
  "execution.continuations@2",
);
export interface Acquisition {
  onDispose(dispose: () => void | Promise<void>): void;
}
export interface Source<B = unknown> {
  readonly owner: string;
  subscribe(
    emit: (body: B, headers?: Record<string, unknown>) => Promise<RunResult>,
    acquisition: Acquisition,
  ): Promise<() => void | Promise<void>>;
}
export interface RouteSpec {
  readonly id: string;
  readonly owner: string;
  readonly version: string;
  readonly tags: readonly string[];
  readonly steps: readonly Step[];
  readonly source?: Source;
  /**
   * Ports this route cannot run without. The kernel refuses to compile the
   * route when no installed plugin provides one, so an ask that only a
   * plugin can honour cannot fail open when that plugin is absent.
   */
  readonly requires?: readonly AnyPort[];
  /** Keys are `namespace.key`, the namespace being an installed plugin's or `route`. The kernel refuses anything else. */
  readonly options?: Readonly<Record<string, unknown>>;
}
export interface RouteStatus {
  readonly state: "enabled" | "disabled" | "circuit-broken";
  readonly owner: string;
  readonly reason: string;
}
export interface Run {
  readonly error?: Fault;
  readonly exchange: Exchange;
  readonly kind: RunKind;
  readonly signal: AbortSignal;
  readonly pending: readonly string[];
  /** On a resume: which step parked, and what it asked to get back. */
  readonly resumption?: { readonly site: string; readonly stepState?: unknown };
}
export type Next = (run: Run) => Promise<RunResult>;
export interface RouteBinding {
  readonly route: RouteSpec;
  setStatus(state: RouteStatus["state"], reason: string): void;
}
export interface Anchor {
  readonly port: AnyPort;
  readonly name: string;
  readonly key: symbol;
}
export function anchor(contract: AnyPort, name: string): Anchor {
  return Object.freeze({ port: contract, name, key: Symbol(name) });
}
export interface Constraint {
  readonly anchor: Anchor;
  readonly presence: "required" | "ifPresent";
}
export interface Ordered {
  readonly id: string;
  readonly anchor?: Anchor;
  readonly before?: readonly Constraint[];
  readonly after?: readonly Constraint[];
}
/** The kernel's own point identities. A package declaring a new point supplies its own. */
export const ADMISSION_POINT: unique symbol = Symbol("admission");
export const ENTRY_POINT: unique symbol = Symbol("entry");
export const ERROR_POINT: unique symbol = Symbol("error");
export const EXIT_POINT: unique symbol = Symbol("exit");
/**
 * Open by declaration merging. Adding a point does not invent a lifecycle:
 * its owner must invoke it. Each point carries two things: an `owner`
 * identity, a unique symbol, so two packages declaring the same name with
 * different identities fail to compile; and `refuse`, which says whether a
 * handler at that point may refuse the exchange. The same two facts are
 * declared once more at runtime through {@link point}, and a plugin that
 * declares a point installs that descriptor, so the policy the compiler
 * enforced through {@link HandlerDecision} is the policy the runtime applies
 * to a caller the compiler did not see (`REFUSE_UNSUPPORTED`).
 */
export interface HandlerPoints {
  admission: { readonly owner: typeof ADMISSION_POINT; readonly refuse: true };
  entry: { readonly owner: typeof ENTRY_POINT; readonly refuse: true };
  error: { readonly owner: typeof ERROR_POINT; readonly refuse: false };
  exit: { readonly owner: typeof EXIT_POINT; readonly refuse: false };
}
export interface PointDescriptor<
  K extends keyof HandlerPoints = keyof HandlerPoints,
> {
  readonly name: K;
  readonly owner: symbol;
  readonly refuse: boolean;
}
/**
 * The runtime half of a point declaration. The owner identity and the
 * refusal policy must be the ones the merged type declares, so the two
 * halves cannot drift: `point("exit", EXIT_POINT, true)` does not compile.
 */
export function point<K extends keyof HandlerPoints>(
  name: K,
  owner: HandlerPoints[K]["owner"],
  refuse: HandlerPoints[K]["refuse"],
): PointDescriptor<K> {
  return Object.freeze({ name, owner, refuse });
}
export const KERNEL_POINTS: readonly PointDescriptor[] = Object.freeze([
  point("admission", ADMISSION_POINT, true),
  point("entry", ENTRY_POINT, true),
  point("error", ERROR_POINT, false),
  point("exit", EXIT_POINT, false),
]);
type Refusal<K> = K extends keyof HandlerPoints
  ? HandlerPoints[K] extends { readonly refuse: true }
    ? { readonly kind: "refuse"; readonly reason: string }
    : never
  : never;
export type HandlerDecision<
  K extends keyof HandlerPoints = keyof HandlerPoints,
> = { readonly kind: "allow"; readonly exchange: Exchange } | Refusal<K>;
export interface Selector {
  readonly routeId?: string;
  readonly tag?: string;
}
/** What a handler learns beside the exchange. `resume` is present at admission of a resume: the exchange is then the INGRESS, and this is what it asks to revive. */
export interface HandlerInfo {
  readonly kind: RunKind;
  readonly route: RouteSpec;
  readonly error?: Fault;
  readonly resume?: {
    readonly id: string;
    readonly deferred: SerializedExchange;
  };
}
export interface HandlerAt<K extends keyof HandlerPoints> extends Ordered {
  readonly kind: "handler";
  readonly point: K;
  readonly selector?: Selector;
  readonly survival: Survival;
  handle(
    exchange: Exchange,
    info: HandlerInfo,
  ): HandlerDecision<K> | Promise<HandlerDecision<K>>;
}
/**
 * Distributed over the points, so the broad type is a union of per-point
 * handlers in which `point` and the decision stay correlated: a handler
 * typed as plain `Handler` that names `exit` still cannot return a refusal.
 */
export type Handler<K extends keyof HandlerPoints = keyof HandlerPoints> =
  K extends keyof HandlerPoints ? HandlerAt<K> : never;
export interface Wrapper extends Ordered {
  readonly kind: "wrapper";
  readonly survival: Survival;
  bind(binding: RouteBinding): (next: Next, run: Run) => Promise<RunResult>;
}
export type Contribution = Handler | Wrapper;
/**
 * What a resume brings. The ingress route verified `headers` live; they are
 * what admission authorises and what the continuation records as data. They
 * are never merged into the continuation: it runs as the exchange that
 * parked, whose principal an auth plugin will find restored, never
 * authentic. `payload` reaches it as `routecraft.deferral.result`.
 */
export interface ResumeIngress {
  readonly payload?: unknown;
  readonly headers?: Record<string, unknown>;
  readonly signal?: AbortSignal;
}
export interface SweepOptions {
  readonly now?: number;
  /** Claims older than this many milliseconds are released before scanning. Absent: no healing this pass. */
  readonly lease?: number;
  /** Settled records older than this many milliseconds are purged. Absent: no purge this pass. */
  readonly retention?: number;
  readonly pageSize?: number;
}
export interface SweepReport {
  readonly released: number;
  readonly purged: number;
  readonly visited: number;
  readonly retired: number;
  /** Due records whose route this application does not have, by route id. Left for the deployment that owns them. */
  readonly orphans: Readonly<Record<string, number>>;
}
export interface Execution {
  deliver(
    routeId: string,
    body: unknown,
    headers?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<RunResult>;
  resume(id: string, ingress?: ResumeIngress): Promise<RunResult>;
  /** Heal, purge, then deliver every due continuation to its route's error channel once and settle it expired. */
  sweep(options?: SweepOptions): Promise<SweepReport>;
  errorChannel(
    routeId: string,
    exchange: Exchange,
    error: Fault,
  ): Promise<RunResult>;
}
export interface PluginContext {
  readonly execution: Execution;

  readonly id: string;
  require<T>(contract: Port<T>): T;
  provide<T>(contract: Port<T>, value: T): void;
  onDispose(dispose: () => void | Promise<void>): void;
  observe(
    observer: (event: Readonly<{ name: string; data: unknown }>) => unknown,
  ): void;
  /** Emit under this plugin's namespace: `deferral:boot`, never a bare name. */
  emit(name: string, data: unknown): void;
  contribute<K extends keyof HandlerPoints>(
    contribution: Handler<K> | Wrapper,
  ): void;
}
export type FacetFactories = Readonly<
  Record<string, (exchange: Exchange, services: ServiceLookup) => unknown>
>;
export interface Installation {
  readonly id: string;
  /**
   * The prefix this plugin's strings live under: its facet key and its route
   * option keys. Defaults to the last segment of `id`. Unique per
   * application, which is what makes two plugins' strings unable to collide.
   */
  readonly namespace?: string;
  readonly requires?: readonly AnyPort[];
  readonly provides?: readonly AnyPort[];
  /** Contract replacements; an alternative may be installed alone or displace one default provider. */
  readonly replaces?: readonly AnyPort[];
  /** Handler points this plugin owns and invokes. Registered before any binding, so a contribution to one is checked against its policy. */
  readonly points?: readonly PointDescriptor[];
  bind?(context: PluginContext): void | Promise<void>;
  start?(context: PluginContext): void | Promise<void>;
  stop?(context: PluginContext): void | Promise<void>;
}
export function namespaceOf(p: Pick<Installation, "id" | "namespace">): string {
  return p.namespace ?? p.id.slice(p.id.lastIndexOf(".") + 1);
}
