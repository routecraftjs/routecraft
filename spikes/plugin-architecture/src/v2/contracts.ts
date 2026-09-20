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
export interface Principal {
  readonly subject: string;
  readonly grants: readonly string[];
  readonly lent: readonly string[];
}
export interface Exchange<B = unknown, H = Record<string, unknown>> {
  readonly id: string;
  readonly routeId: string;
  body: B;
  headers: H;
  principal: Principal;
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
export interface DeferRequest {
  readonly id: string;
  readonly reason: string;
  readonly reenter?: boolean;
}
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
  readonly status: "completed" | "dropped" | "deferred" | "refused";
  readonly exchanges: readonly Exchange[];
  readonly deferrals: readonly string[];
}
export interface Continuation {
  readonly codec: 1;
  readonly routeId: string;
  readonly plan: string;
  readonly pending: readonly string[];
  readonly exchange: Exchange;
}
/** Semantic persistence boundary, not a generic KV contract in the executor. */
export interface ContinuationStore {
  save(id: string, continuation: Continuation): Promise<void>;
  read(id: string): Promise<Continuation | undefined>;
  claim(id: string): Promise<Continuation | undefined>;
  finish(id: string, state: "completed" | "failed"): Promise<void>;
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
    emit: (body: B, principal?: Principal) => Promise<RunResult>,
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
/** Open by declaration merging. Adding a point does not invent a lifecycle: its owner must invoke it. */
export interface HandlerPoints {
  admission: true;
  entry: true;
  error: true;
  exit: true;
}
export type HandlerDecision =
  | { readonly kind: "allow"; readonly exchange: Exchange }
  | { readonly kind: "refuse"; readonly reason: string };
export interface Selector {
  readonly routeId?: string;
  readonly tag?: string;
}
export interface Handler extends Ordered {
  readonly kind: "handler";
  readonly point: keyof HandlerPoints;
  readonly selector?: Selector;
  readonly survival: Survival;
  handle(
    exchange: Exchange,
    info: { readonly kind: RunKind; readonly error?: Fault },
  ): HandlerDecision | Promise<HandlerDecision>;
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
    principal?: Principal,
    signal?: AbortSignal,
  ): Promise<RunResult>;
  resume(id: string): Promise<RunResult>;
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
  contribute(contribution: Contribution): void;
}
export type FacetFactories = Readonly<
  Record<string, (exchange: Exchange, services: ServiceLookup) => unknown>
>;
export interface Installation {
  readonly id: string;
  readonly requires?: readonly AnyPort[];
  readonly provides?: readonly AnyPort[];
  /** Contract replacements; an alternative may be installed alone or displace one default provider. */
  readonly replaces?: readonly AnyPort[];
  bind?(context: PluginContext): void | Promise<void>;
  start?(context: PluginContext): void | Promise<void>;
  stop?(context: PluginContext): void | Promise<void>;
}
