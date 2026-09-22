import { createHash, randomUUID } from "node:crypto";
import { Host, type Owned } from "./host.ts";
import { encode, decode, canonical } from "./codec.ts";
import {
  CONTINUATIONS,
  Fault,
  fault,
  type Exchange,
  type Step,
  type StepContext,
  type RouteSpec,
  type Run,
  type RunResult,
  type Next,
  type Handler,
  type HandlerInfo,
  type Contribution,
  type HandlerPoints,
  type RunKind,
  type RouteStatus,
  type Continuation,
  type ContinuationRecord,
  type Frame,
  type ResumeIngress,
  type SerializedExchange,
  type SerializedOutcome,
  type SweepOptions,
  type SweepReport,
  DEFERRAL_SEQUENCE,
  DEFERRAL_RESULT,
  DEFERRAL_RESUMED_AT,
  DEFERRAL_INGRESS,
} from "./contracts.ts";
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
const empty = (): RunResult => ({
  status: "completed",
  exchanges: [],
  deferrals: [],
});
/** A fresh core envelope so facets attach cleanly. Bodies are not cloned: a stream or a class instance is an ordinary body in flight. */
export function wireExchange(ex: Exchange): Exchange {
  return { id: ex.id, routeId: ex.routeId, body: ex.body, headers: ex.headers };
}
/** The plain-JSON form that crosses the store, by the persistence codec, naming the step that tried to park what it refuses. */
function serialize(ex: Exchange, owner: string): SerializedExchange {
  return {
    id: ex.id,
    routeId: ex.routeId,
    body: encode(ex.body, owner, "body"),
    headers: encode(ex.headers, owner, "headers") as Record<string, unknown>,
  };
}
function revive(x: SerializedExchange): Exchange {
  return {
    id: x.id,
    routeId: x.routeId,
    body: decode(x.body),
    headers: decode(x.headers) as Record<string, unknown>,
  };
}
/**
 * Project a `Step.source` value into something hashable, recursively: a
 * function by its verbatim source text at ANY depth, so a callback nested in
 * an option object is a step definition just as a top-level callable is;
 * plain data as itself; the carriers an option realistically names a target
 * with by a tagged rendering; anything else as an opaque marker, and
 * anything past four levels as `[deep]`, so hashing a route is never a graph
 * traversal. Source is never normalised: every fold of two texts onto one
 * digest is a chance to resume an approval into behaviour it never covered.
 */
function project(value: unknown, depth = 0): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : "[number]";
    case "bigint":
      return `[bigint:${String(value)}]`;
    case "undefined":
      return undefined;
    case "symbol":
      return "[symbol]";
    case "function":
      return Function.prototype.toString.call(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return `[url:${value.href}]`;
  if (value instanceof RegExp) return `[regexp:${value.source}/${value.flags}]`;
  if (depth >= 4) return "[deep]";
  if (value instanceof Map)
    return {
      "[map]": [...value].map(([k, v]) => [
        project(k, depth + 1),
        project(v, depth + 1),
      ]),
    };
  if (value instanceof Set)
    return { "[set]": [...value].map((v) => project(v, depth + 1)) };
  if (Array.isArray(value)) return value.map((v) => project(v, depth + 1));
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) return "[opaque]";
  const out: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    out[k] = project(v, depth + 1);
  return out;
}
/**
 * Hash of the step DEFINITIONS a parked exchange will run when it resumes:
 * ids, owners, versions, declared children, and every value a step names in
 * `source`, projected by {@link project}. Nothing outside the tail is folded
 * in, so an unrelated plugin or a route option cannot strand every approval
 * in flight, and an edited callable cannot slip under one.
 */
export function tailHash(
  steps: ReadonlyMap<string, Step>,
  pending: readonly string[],
) {
  const describe = (step: Step): unknown => ({
    id: step.id,
    owner: step.owner,
    version: step.version,
    source: (step.source ?? []).map((v) => project(v)),
    children: step.children?.map(describe) ?? [],
  });
  return createHash("sha256")
    .update(canonical(pending.map((id) => describe(steps.get(id)!))))
    .digest("hex");
}
interface Compiled {
  spec: RouteSpec;
  steps: Map<string, Step>;
  /** Every declared list by owner: the route's own under `null`, a step's children under its id. */
  lists: Map<string | null, readonly string[]>;
  position: Map<string, { list: string | null; index: number }>;
  initial: readonly string[];
  invoke: Next;
  status: RouteStatus;
}
/**
 * Address the path still to run as suffixes of declared lists, anchored at
 * the defer site even when nothing follows it, so a step appended after the
 * site later is part of the live tail the resume compares.
 */
function framesOf(
  route: Compiled,
  site: string,
  reenter: boolean,
  remaining: readonly string[],
  owner: string,
): Frame[] {
  const at = route.position.get(site);
  if (!at) throw new Fault(owner, "UNKNOWN_INSTRUCTION", site);
  const frames: Frame[] = [
    { list: at.list, from: at.index + (reenter ? 0 : 1) },
  ];
  let i = 0;
  for (;;) {
    const frame = frames[frames.length - 1]!;
    const suffix = route.lists.get(frame.list)!.slice(frame.from);
    if (!suffix.every((id, k) => remaining[i + k] === id))
      throw new Fault(owner, "UNSTRUCTURED_PENDING", remaining.join(","));
    i += suffix.length;
    if (i >= remaining.length) return frames;
    const next = route.position.get(remaining[i]!);
    if (!next) throw new Fault(owner, "UNKNOWN_INSTRUCTION", remaining[i]!);
    frames.push({ list: next.list, from: next.index });
  }
}
/** The live path the frames address today, or undefined when the graph no longer has it. */
function pendingOf(
  route: Compiled,
  frames: readonly Frame[],
): string[] | undefined {
  const out: string[] = [];
  for (const f of frames) {
    const list = route.lists.get(f.list);
    if (
      !list ||
      !Number.isInteger(f.from) ||
      f.from < 0 ||
      f.from > list.length
    )
      return undefined;
    out.push(...list.slice(f.from));
  }
  return out;
}
/** Execution mechanics only. Contributions provide policy, resources and operation instances. */
export class Runtime {
  readonly #routes = new Map<string, Compiled>();
  readonly #work = new Set<Promise<unknown>>();
  readonly #unsubscribes: {
    owner: string;
    stop: () => void | Promise<void>;
  }[] = [];
  #accept = false;
  #ordered: readonly Owned<Contribution>[] | undefined;
  private get ordered() {
    return (this.#ordered ??= this.host.ordered(this.host.contributions));
  }
  constructor(
    readonly host: Host,
    readonly facets: Readonly<
      Record<string, (exchange: Exchange) => unknown>
    > = {},
  ) {
    host.connect(this);
  }
  compile(spec: RouteSpec) {
    if (this.#accept)
      throw new Fault(spec.owner, "FROZEN", "route compilation");
    if (this.#routes.has(spec.id))
      throw new Fault(spec.owner, "DUPLICATE_ROUTE", spec.id);
    for (const port of spec.requires ?? [])
      if (!this.host.has(port))
        throw new Fault(
          spec.owner,
          "ROUTE_REQUIRES",
          `${spec.id}: ${port.name}`,
        );
    for (const key of Object.keys(spec.options ?? {})) {
      const dot = key.indexOf(".");
      const prefix = key.slice(0, dot);
      if (dot < 1 || (prefix !== "route" && !this.host.namespaces.has(prefix)))
        throw new Fault(
          spec.owner,
          "OPTION_NAMESPACE",
          `${spec.id}: ${key} must be namespace.key for an installed plugin or route`,
        );
    }
    const steps = new Map<string, Step>();
    const lists = new Map<string | null, readonly string[]>();
    const position = new Map<string, { list: string | null; index: number }>();
    const collect = (
      list: readonly Step[],
      owner: string | null,
    ): readonly Step[] => {
      const frozen = Object.freeze(
        list.map((step, index) => {
          if (
            step.owner !== "application" &&
            !this.host.order.some((p) => p.id === step.owner)
          )
            throw new Fault(step.owner, "UNINSTALLED_STEP", step.id);
          const previous = steps.get(step.id);
          if (previous)
            throw new Fault(
              step.owner,
              "DUPLICATE_STEP",
              `${step.id} already owned by ${previous.owner}`,
            );
          position.set(step.id, { list: owner, index });
          const compiled = Object.freeze({
            ...step,
            children: step.children
              ? collect(step.children, step.id)
              : undefined,
          }) as Step;
          steps.set(step.id, compiled);
          return compiled;
        }),
      );
      lists.set(owner, Object.freeze(frozen.map((s) => s.id)));
      return frozen;
    };
    const initial = collect(spec.steps, null);
    const frozen = Object.freeze({
      ...spec,
      tags: Object.freeze([...spec.tags]),
      steps: initial,
      options: Object.freeze({ ...spec.options }),
    });
    const ordered = this.ordered;
    const compiled: Compiled = {
      spec: frozen,
      steps,
      lists,
      position,
      initial: initial.map((s) => s.id),
      status: { state: "enabled", owner: spec.owner, reason: "compiled" },
      invoke: () => Promise.resolve(empty()),
    };
    let next: Next = (run) => this.execute(compiled, run);
    for (const w of [...ordered].reverse())
      if (w.kind === "wrapper") {
        let invoke: ReturnType<typeof w.bind>;
        try {
          invoke = w.bind({
            route: frozen,
            setStatus: (state, reason) => {
              compiled.status = { state, owner: w.owner, reason };
            },
          });
        } catch (e) {
          throw fault(w.owner, "WRAPPER_BIND", e);
        }
        const inner = next;
        next = async (run) => {
          if (!w.survival[run.kind]) return inner(run);
          try {
            return await invoke(inner, run);
          } catch (e) {
            throw fault(w.owner, "WRAPPER", e);
          }
        };
      }
    compiled.invoke = next;
    this.#routes.set(spec.id, compiled);
  }
  async start() {
    this.#accept = true;
    try {
      for (const route of this.#routes.values())
        if (route.spec.source) {
          const source = route.spec.source;
          try {
            const stop = await source.subscribe(
              (body, headers) => this.deliver(route.spec.id, body, headers),
              {
                onDispose: (stop) =>
                  this.#unsubscribes.push({ owner: source.owner, stop }),
              },
            );
            this.#unsubscribes.push({ owner: source.owner, stop });
          } catch (e) {
            throw fault(source.owner, "SOURCE_START", e);
          }
        }
      await this.host.activate();
    } catch (e) {
      const primary = fault("kernel", "START", e);
      try {
        await this.stop();
      } catch (cleanup) {
        if (cleanup instanceof AggregateError)
          primary.secondary.push(...(cleanup.errors as Fault[]));
      }
      throw primary;
    }
  }
  private route(id: string) {
    const route = this.#routes.get(id);
    if (!route) throw new Fault("kernel", "UNKNOWN_ROUTE", id);
    return route;
  }
  private attach(ex: Exchange): Exchange {
    for (const [name, factory] of Object.entries(this.facets)) {
      let made = false,
        value: unknown;
      Object.defineProperty(ex, name, {
        enumerable: false,
        get() {
          if (!made) {
            value = factory(ex);
            made = true;
          }
          return value;
        },
      });
    }
    return ex;
  }
  private own<T>(work: Promise<T>): Promise<T> {
    this.#work.add(work);
    void work.finally(() => this.#work.delete(work)).catch(() => {});
    return work;
  }
  private continuations() {
    return {
      store: this.host.service(CONTINUATIONS),
      provider: this.host.selected.get(CONTINUATIONS.key)!.plugin.id,
    };
  }
  async deliver(
    routeId: string,
    body: unknown,
    headers: Record<string, unknown> = {},
    signal: AbortSignal = new AbortController().signal,
  ): Promise<RunResult> {
    if (!this.#accept) throw new Fault("kernel", "NOT_RUNNING", routeId);
    const route = this.route(routeId);
    if (route.status.state === "disabled")
      throw new Fault(
        route.status.owner,
        "ROUTE_DISABLED",
        route.status.reason,
      );
    return this.own(
      this.enter(route, {
        exchange: { id: randomUUID(), routeId, body, headers: { ...headers } },
        kind: "normal",
        signal,
        pending: route.initial,
      }),
    );
  }
  private duplicate(record: ContinuationRecord): RunResult {
    return {
      status: "duplicate",
      exchanges: record.outcome?.exchanges.map(revive) ?? [],
      deferrals: [],
      ...(record.outcome ? { outcome: record.outcome } : {}),
    };
  }
  /**
   * Retire a waiting record from the resume path, expired or denied, with
   * the same claim, deliver, settle shape the sweep uses, so a crash between
   * the transition and the re-ask heals by redelivery. Reached only by a
   * caller admission accepted: a refused holder must never be able to burn
   * the rightful holder's approval and drive the notification themselves.
   */
  private async settle(
    route: Compiled,
    id: string,
    saved: Continuation,
    now: number,
    error: Fault,
    how: "expired" | "denied",
    reason: string,
  ): Promise<RunResult> {
    const { store } = this.continuations();
    if ((await store.claimExpiry(id, now)) !== "won") {
      // Whoever won says what happened: a concurrent resume that won was accepted, and this caller must not be told otherwise.
      const settled = await store.get(id);
      if (settled?.state === "resumed") return this.duplicate(settled);
      throw error;
    }
    await this.errorChannel(route.spec.id, revive(saved.exchange), error).catch(
      () => undefined,
    );
    if (how === "expired") await store.markExpired(id, now);
    else await store.markDenied(id, now, reason);
    throw error;
  }
  /**
   * The order of checks is the security contract. The door (admission over
   * the ingress) runs before the record's state is disclosed, so a refused
   * caller learns nothing and consumes nothing; the deadline and the live
   * tail are checked next, and only then the compare-and-swap that spends
   * the approval. The continuation then runs as the exchange that parked:
   * the ingress is recorded on it as data, never merged into it.
   */
  async resume(id: string, ingress: ResumeIngress = {}): Promise<RunResult> {
    if (!this.#accept) throw new Fault("kernel", "NOT_RUNNING", "resume");
    const { store, provider } = this.continuations();
    let record: ContinuationRecord | undefined;
    try {
      record = await store.get(id);
    } catch (e) {
      throw fault(provider, "READ_CONTINUATION", e);
    }
    if (!record) throw new Fault(provider, "UNKNOWN_CONTINUATION", id);
    const saved = record.continuation;
    const route = this.route(saved.routeId);
    const door: Exchange = {
      id: saved.exchange.id,
      routeId: route.spec.id,
      body: ingress.payload,
      headers: { ...ingress.headers },
    };
    const admitted = await this.handlers(
      route,
      "admission",
      this.attach(door),
      "resume",
      undefined,
      { id, deferred: saved.exchange },
    );
    if (!admitted) return { status: "refused", exchanges: [], deferrals: [] };
    let recorded: unknown;
    try {
      recorded = encode(admitted.headers, provider, "ingress headers");
    } catch (e) {
      throw fault(provider, "INGRESS_NOT_PERSISTABLE", e);
    }
    // An approver double-clicks, a webhook is redelivered: the normal case, answered from the cache, after the door.
    if (record.state === "resumed") return this.duplicate(record);
    if (record.state !== "waiting" || record.claimedAt !== undefined)
      throw new Fault(
        provider,
        "RESUME_SETTLED",
        `${id}: ${record.state === "waiting" ? "claimed" : record.state}`,
      );
    const now = Date.now();
    if (saved.expiresAt !== undefined && saved.expiresAt <= now)
      return this.settle(
        route,
        id,
        saved,
        now,
        new Fault(provider, "EXPIRED", id),
        "expired",
        "expired before resume",
      );
    const live = saved.codec === 2 ? pendingOf(route, saved.frames) : undefined;
    if (!live || saved.tail !== tailHash(route.steps, live))
      return this.settle(
        route,
        id,
        saved,
        now,
        new Fault(provider, "PLAN_MISMATCH", id),
        "denied",
        "continuation changed",
      );
    let cas: "won" | "lost";
    try {
      cas = await store.markResumed(id, now);
    } catch (e) {
      throw fault(provider, "MARK_RESUMED", e);
    }
    if (cas === "lost") {
      const settled = await store.get(id);
      if (settled?.state === "resumed") return this.duplicate(settled);
      throw new Fault(provider, "RESUME_LOST", id);
    }
    const parked = revive(saved.exchange);
    const exchange: Exchange = {
      ...parked,
      headers: {
        ...parked.headers,
        [DEFERRAL_RESULT]: ingress.payload,
        [DEFERRAL_RESUMED_AT]: now,
        [DEFERRAL_INGRESS]: recorded,
      },
    };
    return this.own(
      (async () => {
        let result: RunResult;
        try {
          result = await this.enter(
            route,
            {
              exchange,
              kind: "resume",
              signal: ingress.signal ?? new AbortController().signal,
              pending: live,
              resumption: {
                site: saved.site,
                ...(saved.stepState !== undefined
                  ? { stepState: decode(saved.stepState) }
                  : {}),
              },
            },
            true,
          );
        } catch (e) {
          // Recording the failure keeps a replay idempotent: a duplicate is told it failed, not re-run.
          await store
            .recordOutcome(id, {
              status: "failed",
              exchanges: [],
              error: String(e),
            })
            .catch(() => undefined);
          throw e;
        }
        // Only what is persistable is cached; a completion whose output is not JSON data is still a completion.
        const exchanges: SerializedExchange[] = [];
        let omitted = 0;
        for (const x of result.exchanges)
          try {
            exchanges.push(serialize(x, provider));
          } catch {
            omitted++;
          }
        const outcome: SerializedOutcome = {
          status: result.status,
          exchanges,
          ...(omitted ? { omitted } : {}),
        };
        try {
          await store.recordOutcome(id, outcome);
        } catch (e) {
          const f = fault(provider, "RECORD_OUTCOME", e);
          this.host.emit("continuation:unrecorded", { id, fault: f.message });
        }
        return result;
      })(),
    );
  }
  /**
   * Heal claims past their lease, purge settled records past retention, then
   * page through what is due by keyset cursor: a record this pass visited
   * and could not retire (an orphan of a route this application lacks, a
   * claim another holder took) is behind the cursor, never re-read, so it
   * cannot starve the records after it. Each retirement is claim, deliver
   * to the error channel, settle, which is the at-least-once trade that is
   * safe for a notification and never for a continuation.
   */
  async sweep({
    now = Date.now(),
    lease,
    retention,
    pageSize = 100,
  }: SweepOptions = {}): Promise<SweepReport> {
    if (!this.#accept) throw new Fault("kernel", "NOT_RUNNING", "sweep");
    const { store, provider } = this.continuations();
    const released =
      lease !== undefined ? await store.releaseClaims(now - lease) : 0;
    const purged =
      retention !== undefined ? await store.purgeSettled(now - retention) : 0;
    const orphans: Record<string, number> = {};
    let visited = 0,
      retired = 0,
      cursor: { id: string; expiresAt: number } | undefined;
    for (;;) {
      const page = await store.findExpired(now, pageSize, cursor);
      if (!page.length) break;
      for (const entry of page) {
        cursor = entry;
        visited++;
        const route = this.#routes.get(entry.routeId);
        if (!route) {
          orphans[entry.routeId] = (orphans[entry.routeId] ?? 0) + 1;
          continue;
        }
        if ((await store.claimExpiry(entry.id, now)) !== "won") continue;
        const record = await store.get(entry.id);
        if (!record) continue;
        // The error channel rethrows after the handlers ran; the nag was delivered either way.
        await this.errorChannel(
          route.spec.id,
          revive(record.continuation.exchange),
          new Fault(provider, "EXPIRED", entry.id),
        ).catch(() => undefined);
        if ((await store.markExpired(entry.id, now)) === "won") retired++;
      }
      if (page.length < pageSize) break;
    }
    return { released, purged, visited, retired, orphans };
  }
  errorChannel(
    routeId: string,
    exchange: Exchange,
    error: Fault,
  ): Promise<RunResult> {
    if (!this.#accept)
      throw new Fault(error.plugin, "NOT_RUNNING", "errorChannel");
    return this.own(
      this.enter(this.route(routeId), {
        exchange,
        kind: "errorChannel",
        signal: new AbortController().signal,
        pending: [],
        error,
      }),
    );
  }
  private async handlers(
    route: Compiled,
    point: keyof HandlerPoints,
    exchange: Exchange,
    kind: RunKind,
    error?: Fault,
    resume?: HandlerInfo["resume"],
  ): Promise<Exchange | null> {
    const descriptor = this.host.points.get(point);
    if (!descriptor) throw new Fault("kernel", "UNKNOWN_POINT", String(point));
    let ex = exchange;
    const handlers = this.ordered.filter(
      (x): x is Owned<Handler> => x.kind === "handler" && x.point === point,
    );
    const info: HandlerInfo = {
      kind,
      route: route.spec,
      ...(error ? { error } : {}),
      ...(resume ? { resume } : {}),
    };
    for (const h of handlers) {
      if (
        !h.survival[kind] ||
        (h.selector?.routeId && h.selector.routeId !== route.spec.id) ||
        (h.selector?.tag && !route.spec.tags.includes(h.selector.tag))
      )
        continue;
      try {
        const result = await h.handle(ex, info);
        if (result.kind === "refuse") {
          // The type forbids this where the point declares no refusal; a caller the compiler did not see is named rather than ignored.
          if (!descriptor.refuse) {
            const refusal = new Fault(
              h.owner,
              "REFUSE_UNSUPPORTED",
              `${String(point)}: ${h.id}`,
            );
            if (error) {
              error.secondary.push(refusal);
              continue;
            }
            throw refusal;
          }
          return null;
        }
        ex = this.attach(wireExchange(result.exchange));
      } catch (e) {
        const failure = fault(h.owner, `HANDLER_${String(point)}`, e);
        if (error) {
          error.secondary.push(failure);
          continue;
        }
        throw failure;
      }
    }
    return ex;
  }
  private async enter(
    route: Compiled,
    run: Run,
    alreadyAdmitted = false,
  ): Promise<RunResult> {
    let ex = this.attach(wireExchange(run.exchange));
    this.host.emit("exchange:started", {
      route: route.spec.id,
      kind: run.kind,
      id: ex.id,
    });
    try {
      if (!alreadyAdmitted) {
        const admitted = await this.handlers(route, "admission", ex, run.kind);
        if (!admitted)
          return { status: "refused", exchanges: [], deferrals: [] };
        ex = admitted;
      }
      const entered = await this.handlers(route, "entry", ex, run.kind);
      if (!entered) return { status: "refused", exchanges: [], deferrals: [] };
      ex = entered;
      const ran = await route.invoke({ ...run, exchange: ex });
      // Exit decoration reaches the caller, not only the next exit handler.
      const exchanges: Exchange[] = [];
      for (const completed of ran.exchanges)
        exchanges.push(
          (await this.handlers(route, "exit", completed, run.kind)) ??
            completed,
        );
      const result: RunResult = { ...ran, exchanges };
      this.host.emit(`exchange:${result.status}`, {
        id: ex.id,
        route: route.spec.id,
      });
      return result;
    } catch (e) {
      const primary = fault(route.spec.owner, "EXECUTION", e);
      await this.handlers(route, "error", ex, run.kind, primary);
      this.host.emit("exchange:failed", {
        plugin: primary.plugin,
        message: primary.message,
      });
      throw primary;
    }
  }
  private async execute(route: Compiled, run: Run): Promise<RunResult> {
    if (run.error) throw run.error;
    const queue: { ex: Exchange; pending: readonly string[] }[] = [
      { ex: run.exchange, pending: run.pending },
    ];
    const streams: Promise<unknown>[] = [];
    const exchanges: Exchange[] = [],
      deferrals: string[] = [];
    let dropped = false;
    while (queue.length) {
      const item = queue.shift()!;
      let ex = item.ex;
      let pending = [...item.pending];
      while (pending.length) {
        run.signal.throwIfAborted();
        const id = pending.shift()!;
        const step = route.steps.get(id);
        if (!step) throw new Fault(route.spec.owner, "UNKNOWN_INSTRUCTION", id);
        let active = true;
        const attemptId = randomUUID();
        const assertActive = () => {
          run.signal.throwIfAborted();
          if (!active) throw new Fault(step.owner, "LATE_EFFECT", id);
        };
        const nested = async (path: {
          steps: readonly Step[];
          exchange: Exchange;
        }) => {
          try {
            const result = await this.execute(route, {
              ...run,
              exchange: path.exchange,
              pending: this.ids(route, path.steps, step.owner),
            });
            return { failed: false, dropped: result.status === "dropped" };
          } catch (e) {
            const f = fault(step.owner, "NESTED", e);
            this.host.emit("path:failed", {
              plugin: f.plugin,
              message: f.message,
            });
            return {
              failed: !run.signal.aborted,
              dropped: false,
              error: f,
              aborted: run.signal.aborted,
            };
          }
        };
        const ctx: StepContext = {
          signal: run.signal,
          attemptId,
          kind: run.kind,
          ...(run.resumption?.site === id
            ? { stepState: run.resumption.stepState }
            : {}),
          require: (contract) => this.host.requireFor(step.owner, contract),
          commit: (effect) => {
            assertActive();
            return effect();
          },
          track: (work) => {
            assertActive();
            const tracked = work.catch((e) => {
              throw fault(step.owner, "STREAM", e);
            });
            streams.push(tracked);
            this.own(tracked);
          },
          takePending: (predicate) => {
            assertActive();
            const taken: Exchange[] = [];
            for (let i = queue.length - 1; i >= 0; i--)
              if (predicate(queue[i]!.ex))
                taken.unshift(queue.splice(i, 1)[0]!.ex);
            return taken;
          },
          runPath: nested,
          runPaths: async (paths) => {
            await Promise.allSettled(paths.map(nested));
          },
          captureDownstream: (kind = "debounce") => {
            assertActive();
            const saved = [...pending];
            return (exchange) => {
              if (!this.#accept)
                throw new Fault(step.owner, "NOT_RUNNING", kind);
              return this.own(
                this.enter(route, {
                  exchange,
                  kind,
                  pending: saved,
                  signal: new AbortController().signal,
                }),
              );
            };
          },
          dispatch: (routeId, exchange) => {
            assertActive();
            const target = this.route(routeId);
            return this.own(
              this.enter(target, {
                ...run,
                exchange: { ...wireExchange(exchange), routeId },
                kind: "normal",
                pending: target.initial,
              }),
            );
          },
          invoke: (point, exchange) =>
            this.handlers(route, point, exchange, run.kind),
        };
        try {
          const outcome = await abortable(
            this.own(
              Promise.resolve().then(() =>
                step.execute(this.attach(wireExchange(ex)), ctx),
              ),
            ),
            run.signal,
          );
          assertActive();
          active = false;
          switch (outcome.kind) {
            case "continue":
              ex = outcome.exchange;
              break;
            case "complete":
              exchanges.push(wireExchange(outcome.exchange));
              pending = [];
              ex = outcome.exchange;
              break;
            case "drop":
              dropped = true;
              pending = [];
              break;
            case "branch":
              ex = outcome.exchange;
              pending = [
                ...this.ids(route, outcome.steps, step.owner),
                ...pending,
              ];
              break;
            case "fanOut":
              for (const child of outcome.exchanges)
                queue.push({
                  ex: this.attach(wireExchange(child)),
                  pending: [...pending],
                });
              pending = [];
              break;
            case "defer": {
              if (!this.host.has(CONTINUATIONS))
                throw new Fault(step.owner, "MISSING_CONTINUATION_STORE", id);
              const { store, provider } = this.continuations();
              const sequence =
                (Number(outcome.exchange.headers[DEFERRAL_SEQUENCE]) || 0) + 1;
              const continuationId = `${outcome.exchange.id}#${sequence}`;
              const parked: Exchange = {
                ...outcome.exchange,
                headers: {
                  ...outcome.exchange.headers,
                  [DEFERRAL_SEQUENCE]: sequence,
                },
              };
              const reenter = outcome.request.reenter === true;
              const remaining = reenter ? [id, ...pending] : pending;
              const saved: Continuation = {
                codec: 2,
                routeId: route.spec.id,
                site: id,
                frames: framesOf(route, id, reenter, remaining, step.owner),
                tail: tailHash(route.steps, remaining),
                exchange: serialize(parked, step.owner),
                parkedAt: Date.now(),
                ...(outcome.request.ttl !== undefined
                  ? { expiresAt: Date.now() + outcome.request.ttl }
                  : {}),
                ...(outcome.request.state !== undefined
                  ? {
                      stepState: encode(
                        outcome.request.state,
                        step.owner,
                        "stepState",
                      ),
                    }
                  : {}),
              };
              try {
                await store.create(continuationId, saved);
              } catch (e) {
                throw fault(provider, "PARK", e);
              }
              deferrals.push(continuationId);
              pending = [];
              break;
            }
            default:
              throw new Fault(
                step.owner,
                "UNKNOWN_OUTCOME",
                JSON.stringify(outcome),
              );
          }
          if (!pending.length && outcome.kind === "continue")
            exchanges.push(wireExchange(ex));
        } catch (e) {
          active = false;
          throw fault(step.owner, "STEP", e);
        }
      }
      if (item.pending.length === 0) exchanges.push(wireExchange(ex));
    }
    const settled = await Promise.allSettled(streams);
    const failed = settled.find((x) => x.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    return {
      status: deferrals.length
        ? "deferred"
        : exchanges.length
          ? "completed"
          : dropped
            ? "dropped"
            : "completed",
      exchanges,
      deferrals,
    };
  }
  private ids(
    route: Compiled,
    steps: readonly Step[],
    owner: string,
  ): string[] {
    return steps.map((s) => {
      const known = route.steps.get(s.id);
      if (
        !known ||
        known.owner !== s.owner ||
        known.version !== s.version ||
        known.execute !== s.execute
      )
        throw new Fault(owner, "UNDECLARED_BRANCH", s.id);
      return s.id;
    });
  }
  status(id: string) {
    return this.route(id).status;
  }
  dump() {
    return {
      ...this.host.dump(),
      routes: [...this.#routes.values()].map((r) => ({
        id: r.spec.id,
        instructions: [...r.steps.values()].map((s) => ({
          id: s.id,
          owner: s.owner,
          version: s.version,
        })),
        status: r.status,
      })),
    };
  }
  /**
   * Drain for at most `timeout` milliseconds, then abandon what is still
   * running and dispose. A step that ignores cancellation forever must not
   * hold the process open forever; what it was doing is reported, not waited
   * for.
   */
  async stop(timeout = 30_000) {
    this.#accept = false;
    const errors: Fault[] = [];
    for (const sub of this.#unsubscribes.splice(0).reverse())
      try {
        await sub.stop();
      } catch (e) {
        errors.push(fault(sub.owner, "UNSUBSCRIBE", e));
      }
    const deadline = Date.now() + timeout;
    while (this.#work.size) {
      const left = deadline - Date.now();
      if (left <= 0) {
        this.host.emit("drain:abandoned", { pending: this.#work.size });
        errors.push(
          new Fault(
            "kernel",
            "DRAIN_TIMEOUT",
            `${this.#work.size} still running after ${timeout}ms`,
          ),
        );
        break;
      }
      await Promise.race([
        Promise.allSettled([...this.#work]),
        new Promise((r) => setTimeout(r, left)),
      ]);
    }
    errors.push(...(await this.host.dispose()));
    if (errors.length)
      throw new AggregateError(errors, errors.map((e) => e.message).join("\n"));
  }
}
