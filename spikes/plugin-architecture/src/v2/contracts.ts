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
}
export const DEFERRAL_SEQUENCE = "routecraft.deferral.sequence";
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
   * tail hash a parked exchange is checked against, with functions taken by
   * verbatim source text, so an approval cannot authorise steps that were
   * edited under it.
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
  /** `duplicate` is a second resume of a continuation that already ran: the cached outcome, nothing re-executed. */
  readonly status:
    "completed" | "dropped" | "deferred" | "refused" | "duplicate";
  readonly exchanges: readonly Exchange[];
  readonly deferrals: readonly string[];
}
export interface Continuation {
  readonly codec: 1;
  readonly routeId: string;
  /** Hash of the step definitions after the defer point, callables by source text. Nothing else. */
  readonly tail: string;
  readonly pending: readonly string[];
  readonly exchange: SerializedExchange;
  readonly expiresAt?: number;
}
export interface SerializedOutcome {
  readonly status: RunResult["status"] | "failed";
  readonly exchanges: readonly SerializedExchange[];
  readonly error?: string;
}
export interface ContinuationRecord {
  readonly state: "waiting" | "resumed" | "expired" | "denied";
  readonly continuation: Continuation;
  /** Epoch millis of an outstanding expiry-delivery claim. The record stays waiting. */
  readonly claimedAt?: number;
  readonly resumedAt?: number;
  /** Cached reply for a duplicate resume. Absent between markResumed and recordOutcome. */
  readonly outcome?: SerializedOutcome;
}
export type CasResult = "won" | "lost";
/**
 * Semantic persistence boundary, not a generic KV contract in the executor.
 *
 * Two mechanisms, deliberately asymmetric, because they protect different
 * things. A RESUME is `markResumed`, a compare-and-swap out of `waiting` taken
 * before the continuation runs: exactly one caller wins, a second is told
 * `duplicate` and handed the cached outcome, and a holder that dies mid-run
 * leaves residue that `resumedWithoutOutcome` reports and nothing re-runs,
 * because a half-run continuation may have half-happened side effects. An
 * EXPIRY NOTIFICATION is `claimExpiry`, a claim over a record that stays
 * waiting: a holder that dies mid-delivery is healed by `releaseClaims` once
 * the lease elapses and the next sweep redelivers, because re-sending a nag
 * is safe. Modelling the resume as the lease re-runs continuations; modelling
 * the notification as the CAS loses nags. Both mistakes have been made here.
 */
export interface ContinuationStore {
  /** Refuses a second continuation under one id. */
  create(id: string, continuation: Continuation): Promise<void>;
  get(id: string): Promise<ContinuationRecord | undefined>;
  markResumed(id: string, at: number): Promise<CasResult>;
  recordOutcome(id: string, outcome: SerializedOutcome): Promise<void>;
  claimExpiry(id: string, at: number): Promise<CasResult>;
  markExpired(id: string): Promise<CasResult>;
  releaseClaims(before: number): Promise<number>;
  /** Waiting, unclaimed, due at or before `now`, oldest first. */
  findExpired(now: number, limit?: number): Promise<string[]>;
  /** Resumed records with no cached outcome: a process died mid-continuation. Report, never re-run. */
  resumedWithoutOutcome(): Promise<string[]>;
}
export const CONTINUATIONS = port<ContinuationStore>(
  "execution.continuations@1",
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
 * handler at that point may refuse the exchange. A refusal where it is not
 * honoured is a compile error through {@link HandlerDecision}, and a fault at
 * runtime for a caller the compiler did not see.
 */
export interface HandlerPoints {
  admission: { readonly owner: typeof ADMISSION_POINT; readonly refuse: true };
  entry: { readonly owner: typeof ENTRY_POINT; readonly refuse: true };
  error: { readonly owner: typeof ERROR_POINT; readonly refuse: false };
  exit: { readonly owner: typeof EXIT_POINT; readonly refuse: false };
}
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
export interface Handler<
  K extends keyof HandlerPoints = keyof HandlerPoints,
> extends Ordered {
  readonly kind: "handler";
  readonly point: K;
  readonly selector?: Selector;
  readonly survival: Survival;
  handle(
    exchange: Exchange,
    info: {
      readonly kind: RunKind;
      readonly route: RouteSpec;
      readonly error?: Fault;
    },
  ): HandlerDecision<K> | Promise<HandlerDecision<K>>;
}
export interface Wrapper extends Ordered {
  readonly kind: "wrapper";
  readonly survival: Survival;
  bind(binding: RouteBinding): (next: Next, run: Run) => Promise<RunResult>;
}
export type Contribution = Handler | Wrapper;
export interface Execution {
  deliver(
    routeId: string,
    body: unknown,
    headers?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<RunResult>;
  /** `headers` are the resume ingress: whatever identity they carry is the one authorised, never the stored one. */
  resume(id: string, headers?: Record<string, unknown>): Promise<RunResult>;
  /** Deliver every due continuation to its route's error channel once, then settle it expired. */
  sweep(now?: number): Promise<number>;
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
  bind?(context: PluginContext): void | Promise<void>;
  start?(context: PluginContext): void | Promise<void>;
  stop?(context: PluginContext): void | Promise<void>;
}
export function namespaceOf(p: Pick<Installation, "id" | "namespace">): string {
  return p.namespace ?? p.id.slice(p.id.lastIndexOf(".") + 1);
}
