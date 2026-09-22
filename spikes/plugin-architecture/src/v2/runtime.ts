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
  type DeferRequest,
  type Frame,
  type ResumeIngress,
  type ResumeView,
  type SerializedExchange,
  type SerializedOutcome,
  type SweepOptions,
  type SweepReport,
  DEFERRAL_SEQUENCE,
  DEFERRAL_RESULT,
  DEFERRAL_RESUMED_AT,
  DEFERRAL_RESUMED_BY,
  DEFERRAL_ID,
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
const refused = (): RunResult => ({
  status: "refused",
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
    body: decode(x.body, "body"),
    headers: decode(x.headers, "headers") as Record<string, unknown>,
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
 * Address the path still to run as runs over declared lists. Each frame is
 * the longest run of consecutive ids the remaining path takes from one list:
 * a suffix when the run reaches the list's end, which is what a step appended
 * later joins; a bounded slice when a branch chose part of its children,
 * which an appended child does not join because the branch did not choose
 * it. The first frame is anchored at the defer site even when nothing follows
 * it, so a step appended after a trailing site is in the live tail.
 */
function framesOf(
  route: Compiled,
  site: string | null,
  reenter: boolean,
  remaining: readonly string[],
  owner: string,
): Frame[] {
  const frames: Frame[] = [];
  let i = 0;
  const push = (list: string | null, from: number) => {
    const ids = route.lists.get(list)!;
    let run = 0;
    while (from + run < ids.length && remaining[i + run] === ids[from + run])
      run++;
    frames.push(
      from + run < ids.length ? { list, from, to: from + run } : { list, from },
    );
    i += run;
  };
  if (site === null) push(null, 0);
  else {
    const at = route.position.get(site);
    if (!at) throw new Fault(owner, "UNKNOWN_INSTRUCTION", site);
    push(at.list, at.index + (reenter ? 0 : 1));
  }
  while (i < remaining.length) {
    const next = route.position.get(remaining[i]!);
    if (!next) throw new Fault(owner, "UNKNOWN_INSTRUCTION", remaining[i]!);
    const before = i;
    push(next.list, next.index);
    if (i === before)
      throw new Fault(owner, "UNSTRUCTURED_PENDING", remaining.join(","));
  }
  return frames;
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
      f.from > list.length ||
      (f.to !== undefined &&
        (!Number.isInteger(f.to) || f.to < f.from || f.to > list.length))
    )
      return undefined;
    out.push(...list.slice(f.from, f.to));
  }
  return out;
}
/** What a ring of handlers decided: the exchange as decorated, what they asked to record, or the one that refused or parked. */
type Ring =
  | {
      readonly kind: "allow";
      readonly exchange: Exchange;
      readonly recorded: Record<string, unknown>;
      readonly carry: Record<string, unknown>;
    }
  | {
      readonly kind: "refuse";
      readonly owner: string;
      readonly handler: string;
      readonly reason: string;
      readonly detail?: unknown;
    }
  | {
      readonly kind: "defer";
      readonly owner: string;
      readonly request: DeferRequest;
    };
/** Execution mechanics only. Contributions provide policy, resources and operation instances. */
export class Runtime {
  readonly #routes = new Map<string, Compiled>();
  readonly #work = new Set<Promise<unknown>>();
  readonly #unsubscribes: {
    owner: string;
    stop: () => void | Promise<void>;
  }[] = [];
  #accept = false;
  /** Between the last delivery refused and the last owned promise settled: work already in flight may still reach the error channel. */
  #draining = false;
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
   * the ingress, handed a view of the record without its body) runs before
   * the route is even resolved and before the record's state is disclosed,
   * so a refused caller learns nothing and consumes nothing; the codec, the
   * deadline and the live tail are checked next, and only then the
   * compare-and-swap that spends the approval, which writes what the door
   * recorded about the resumer. The deadline is checked once more after
   * the swap, because the door may have awaited. The continuation then runs
   * as the exchange that parked: nothing the ingress carried is merged in.
   */
  resume(id: string, ingress: ResumeIngress = {}): Promise<RunResult> {
    if (!this.#accept) throw new Fault("kernel", "NOT_RUNNING", "resume");
    // Owned from the first await: a door that settles after a stop began must not run anything on a stopped application.
    return this.own(this.runResume(id, ingress));
  }
  private async runResume(
    id: string,
    ingress: ResumeIngress,
  ): Promise<RunResult> {
    const { store, provider } = this.continuations();
    let record: ContinuationRecord | undefined;
    try {
      record = await store.get(id);
    } catch (e) {
      throw fault(provider, "READ_CONTINUATION", e);
    }
    if (!record) throw new Fault(provider, "UNKNOWN_CONTINUATION", id);
    const saved = record.continuation;
    const known = this.#routes.get(saved.routeId);
    // The door judges before the route is resolved: a route this deployment lacks is not disclosed to a caller it refuses.
    const spec: RouteSpec = known?.spec ?? {
      id: saved.routeId,
      owner: "kernel",
      version: "0",
      tags: [],
      steps: [],
      options: {},
    };
    const view: ResumeView = {
      id,
      stage: "door",
      routeId: saved.routeId,
      site: saved.site,
      parkedAt: saved.parkedAt,
      ...(saved.expiresAt !== undefined ? { expiresAt: saved.expiresAt } : {}),
      ...(saved.refusal !== undefined ? { refusal: saved.refusal } : {}),
      ...(saved.meta !== undefined ? { meta: decode(saved.meta, "meta") } : {}),
      headers: decode(saved.exchange.headers, "headers") as Record<
        string,
        unknown
      >,
      payload: ingress.payload,
      ...(ingress.signal ? { signal: ingress.signal } : {}),
    };
    const door: Exchange = {
      id: saved.exchange.id,
      routeId: saved.routeId,
      body: ingress.payload,
      headers: { ...ingress.headers },
    };
    const ring = await this.handlers(
      spec,
      "admission",
      this.attach(door),
      "resume",
      undefined,
      view,
    );
    if (ring.kind !== "allow") return refused();
    // The door may have awaited; nothing past it runs on a stopped application.
    if (!this.#accept) throw new Fault("kernel", "NOT_RUNNING", "resume");
    let by: unknown;
    try {
      by = encode(ring.recorded, provider, "resume record");
    } catch (e) {
      throw fault(provider, "RECORD_NOT_PERSISTABLE", e);
    }
    const route = this.route(saved.routeId);
    // An approver double-clicks, a webhook is redelivered: the normal case, answered from the cache, after the door.
    if (record.state === "resumed") return this.duplicate(record);
    if (record.state !== "waiting" || record.claimedAt !== undefined)
      throw new Fault(
        provider,
        "RESUME_SETTLED",
        `${id}: ${record.state === "waiting" ? "claimed" : record.state}`,
      );
    // A record from another codec is refused, not settled: nothing about this deployment's plan is known to have changed.
    if (saved.codec !== 2)
      throw new Fault(
        provider,
        "CODEC_MISMATCH",
        `${id}: codec ${String(saved.codec)}`,
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
    const live = pendingOf(route, saved.frames);
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
      cas = await store.markResumed(id, now, by);
    } catch (e) {
      throw fault(provider, "MARK_RESUMED", e);
    }
    if (cas === "lost") {
      const settled = await store.get(id);
      if (settled?.state === "resumed") return this.duplicate(settled);
      throw new Fault(provider, "RESUME_LOST", id);
    }
    // Re-checked after the swap: the door awaited, and a resume that arrived in time must not run past the window its route declared.
    if (saved.expiresAt !== undefined && saved.expiresAt <= Date.now()) {
      const expiry = new Fault(
        provider,
        "EXPIRED",
        `${id}: expired while at the door`,
      );
      await store
        .recordOutcome(id, {
          status: "failed",
          exchanges: [],
          error: expiry.message,
        })
        .catch(() => undefined);
      await this.errorChannel(
        route.spec.id,
        revive(saved.exchange),
        expiry,
      ).catch(() => undefined);
      throw expiry;
    }
    const parked = revive(saved.exchange);
    const exchange: Exchange = {
      ...parked,
      headers: {
        ...parked.headers,
        // What the door decided this run carries (a lend, re-minted live), for this call alone.
        ...ring.carry,
        [DEFERRAL_ID]: id,
        [DEFERRAL_RESULT]: ingress.payload,
        [DEFERRAL_RESUMED_AT]: now,
        [DEFERRAL_RESUMED_BY]: by,
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
                  ? { stepState: decode(saved.stepState, "stepState") }
                  : {}),
              },
            },
            { ...view, stage: "continuation" },
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
   * safe for a notification and never for a continuation. A stop arriving
   * mid-pass ends the pass between records, and the record in flight is
   * delivered, because a claim taken after that point would notify nobody.
   */
  sweep(options: SweepOptions = {}): Promise<SweepReport> {
    if (!this.#accept) throw new Fault("kernel", "NOT_RUNNING", "sweep");
    return this.own(this.runSweep(options));
  }
  private async runSweep({
    now = Date.now(),
    lease,
    retention,
    pageSize = 100,
  }: SweepOptions): Promise<SweepReport> {
    const { store, provider } = this.continuations();
    const released =
      lease !== undefined ? await store.releaseClaims(now - lease) : 0;
    const purged =
      retention !== undefined ? await store.purgeSettled(now - retention) : 0;
    const orphans: Record<string, number> = {};
    let visited = 0,
      retired = 0,
      cursor: { id: string; expiresAt: number } | undefined,
      previous: { id: string; expiresAt: number } | undefined;
    for (;;) {
      if (!this.#accept) break;
      const page = await store.findExpired(now, pageSize, cursor);
      if (!page.length) break;
      for (const entry of page) {
        if (!this.#accept) break;
        // The store promised a page strictly after the cursor; one that is not would loop this pass forever.
        if (
          previous &&
          !(
            entry.expiresAt > previous.expiresAt ||
            (entry.expiresAt === previous.expiresAt && entry.id > previous.id)
          )
        )
          throw new Fault(
            provider,
            "SCAN_STALLED",
            `${entry.id} is not after ${previous.id}`,
          );
        previous = entry;
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
      // A page boundary yields to the event loop, so a long backlog never starves the process.
      await new Promise((r) => setImmediate(r));
    }
    return { released, purged, visited, retired, orphans };
  }
  errorChannel(
    routeId: string,
    exchange: Exchange,
    error: Fault,
  ): Promise<RunResult> {
    // Owned work already in flight when the stop began may still tell its route; nothing new may start.
    if (!this.#accept && !this.#draining)
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
    spec: RouteSpec,
    point: keyof HandlerPoints,
    exchange: Exchange,
    kind: RunKind,
    error?: Fault,
    resume?: ResumeView,
  ): Promise<Ring> {
    const descriptor = this.host.points.get(point);
    if (!descriptor) throw new Fault("kernel", "UNKNOWN_POINT", String(point));
    let ex = exchange;
    const recorded: Record<string, unknown> = {};
    const carry: Record<string, unknown> = {};
    const handlers = this.ordered.filter(
      (x): x is Owned<Handler> => x.kind === "handler" && x.point === point,
    );
    const info: HandlerInfo = {
      kind,
      route: spec,
      ...(error ? { error } : {}),
      ...(resume ? { resume } : {}),
    };
    for (const h of handlers) {
      if (
        !h.survival[kind] ||
        (h.selector?.routeId && h.selector.routeId !== spec.id) ||
        (h.selector?.tag && !spec.tags.includes(h.selector.tag))
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
          return {
            kind: "refuse",
            owner: h.owner,
            handler: h.id,
            reason: result.reason,
            ...(result.detail !== undefined ? { detail: result.detail } : {}),
          };
        }
        if (result.kind === "defer") {
          if (!descriptor.defer || !h.mayDefer) {
            const parking = new Fault(
              h.owner,
              descriptor.defer ? "DEFER_UNDECLARED" : "DEFER_UNSUPPORTED",
              `${String(point)}: ${h.id}`,
            );
            if (error) {
              error.secondary.push(parking);
              continue;
            }
            throw parking;
          }
          return { kind: "defer", owner: h.owner, request: result.request };
        }
        if (result.record !== undefined)
          recorded[this.host.namespaceFor(h.owner)] = result.record;
        if (result.carry !== undefined && resume?.stage === "door")
          Object.assign(carry, result.carry);
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
    return { kind: "allow", exchange: ex, recorded, carry };
  }
  /**
   * Write a continuation: the record and its index in one transaction, the
   * requester told once it is durable, the event after that. One path for a
   * step that parks itself and for a failure an error handler parks.
   */
  private async park(
    route: Compiled,
    exchange: Exchange,
    site: string | null,
    reenter: boolean,
    remaining: readonly string[],
    request: DeferRequest,
    owner: string,
    refusal?: { readonly owner: string; readonly detail: unknown },
  ): Promise<string> {
    if (!this.host.has(CONTINUATIONS))
      throw new Fault(owner, "MISSING_CONTINUATION_STORE", site ?? "admission");
    const { store, provider } = this.continuations();
    // The provider's default deadline applies to every park, not only the ones the DSL made.
    const ttl = request.ttl ?? store.defaults?.ttl;
    const sequence = (Number(exchange.headers[DEFERRAL_SEQUENCE]) || 0) + 1;
    const id = `${exchange.id}#${sequence}`;
    const parked: Exchange = {
      ...exchange,
      headers: { ...exchange.headers, [DEFERRAL_SEQUENCE]: sequence },
    };
    const saved: Continuation = {
      codec: 2,
      routeId: route.spec.id,
      site,
      frames: framesOf(route, site, reenter, remaining, owner),
      tail: tailHash(route.steps, remaining),
      exchange: serialize(parked, owner),
      parkedAt: Date.now(),
      ...(ttl !== undefined ? { expiresAt: Date.now() + ttl } : {}),
      ...(request.state !== undefined
        ? { stepState: encode(request.state, owner, "stepState") }
        : {}),
      ...(request.meta !== undefined
        ? { meta: encode(request.meta, owner, "meta") }
        : {}),
      // Keyed by the refusing plugin's namespace: a plugin reads back only the bound it wrote.
      ...(refusal && refusal.detail !== undefined
        ? {
            refusal: {
              [this.host.namespaceFor(refusal.owner)]: encode(
                refusal.detail,
                owner,
                "refusal",
              ),
            },
          }
        : {}),
    };
    try {
      await store.create(id, saved);
    } catch (e) {
      throw fault(provider, "PARK", e);
    }
    if (request.notify)
      try {
        await request.notify(id);
      } catch (e) {
        // Nobody was told, so nobody can resume: the record is denied rather than left as a live link behind a failed run.
        const now = Date.now();
        if ((await store.claimExpiry(id, now)) === "won")
          await store.markDenied(id, now, "notify failed");
        throw fault(owner, "NOTIFY", e);
      }
    this.host.emit("exchange:deferred", { id, route: route.spec.id });
    return id;
  }
  private async enter(
    route: Compiled,
    run: Run,
    resume?: ResumeView,
  ): Promise<RunResult> {
    let ex = this.attach(wireExchange(run.exchange));
    this.host.emit("exchange:started", {
      route: route.spec.id,
      kind: run.kind,
      id: ex.id,
    });
    /** Faults the error ring has already been told about, so a refusal that becomes a throw is not rung twice. */
    const told = new WeakSet<Fault>();
    const parkFromFailure = async (
      failure: Fault,
    ): Promise<RunResult | undefined> => {
      told.add(failure);
      const ring = await this.handlers(
        route.spec,
        "error",
        ex,
        run.kind,
        failure,
      );
      if (ring.kind !== "defer") return undefined;
      const decline = (code: string, detail: string) => {
        failure.secondary.push(new Fault(ring.owner, code, detail));
        return undefined;
      };
      // A park is refused, before anything is written, where nothing could revive it or where reviving it would repeat work.
      if (run.signal.aborted)
        return decline("DEFER_CANCELLED", "the run was cancelled");
      const site = failure.site;
      const refusal =
        failure.code === "REFUSED"
          ? { owner: failure.plugin, detail: failure.detail }
          : undefined;
      if (!site && !refusal)
        return decline(
          "DEFER_UNSITED",
          "a failure outside any step would resume from the top and re-run completed steps",
        );
      if (
        refusal &&
        resume?.refusal &&
        this.host.namespaceFor(refusal.owner) in resume.refusal
      )
        return decline(
          "DEFER_REPEATED",
          `${refusal.owner} already refused this exchange once; a second park would ask the same question again`,
        );
      // Where the failure was is where the park is: the failing step, re-entered, or the whole route for a refusal at its door.
      const id = site
        ? await this.park(
            route,
            site.exchange,
            site.step,
            true,
            [site.step, ...site.pending],
            ring.request,
            ring.owner,
            refusal,
          )
        : await this.park(
            route,
            ex,
            null,
            false,
            route.initial,
            ring.request,
            ring.owner,
            refusal,
          );
      return { status: "deferred", exchanges: [], deferrals: [id] };
    };
    try {
      if (!resume) {
        const admitted = await this.handlers(
          route.spec,
          "admission",
          ex,
          run.kind,
        );
        if (admitted.kind === "refuse") {
          // A refusal at the door is a failure the error ring may answer by parking the whole route, which is how a step-up begins. The error channel is that ring: a refusal there is final.
          if (run.kind === "errorChannel") return refused();
          const refusal = new Fault(
            admitted.owner,
            "REFUSED",
            `${admitted.handler}: ${admitted.reason}`,
          );
          refusal.detail = admitted.detail;
          return (await parkFromFailure(refusal)) ?? refused();
        }
        if (admitted.kind === "defer")
          throw new Fault(admitted.owner, "DEFER_UNSUPPORTED", "admission");
        ex = admitted.exchange;
      } else if (resume.site === null) {
        // A park raised at the door resumes at the door: the gate is asked again, of what the continuation carries now.
        const readmitted = await this.handlers(
          route.spec,
          "admission",
          ex,
          run.kind,
          undefined,
          resume,
        );
        if (readmitted.kind === "refuse") {
          const refusal = new Fault(
            readmitted.owner,
            "REFUSED",
            `${readmitted.handler}: ${readmitted.reason}`,
          );
          refusal.detail = readmitted.detail;
          // After the claim a refusal is a failure: the route is told, may park again (once), and the record ends failed.
          const parked = await parkFromFailure(refusal);
          if (parked) return parked;
          throw refusal;
        }
        if (readmitted.kind === "defer")
          throw new Fault(readmitted.owner, "DEFER_UNSUPPORTED", "admission");
        ex = readmitted.exchange;
      }
      const entered = await this.handlers(
        route.spec,
        "entry",
        ex,
        run.kind,
        undefined,
        resume,
      );
      if (entered.kind === "refuse") return refused();
      if (entered.kind === "defer")
        throw new Fault(entered.owner, "DEFER_UNSUPPORTED", "entry");
      ex = entered.exchange;
      const ran = await route.invoke({ ...run, exchange: ex });
      // Exit decoration reaches the caller, not only the next exit handler.
      const exchanges: Exchange[] = [];
      for (const completed of ran.exchanges) {
        const exit = await this.handlers(
          route.spec,
          "exit",
          completed,
          run.kind,
        );
        exchanges.push(exit.kind === "allow" ? exit.exchange : completed);
      }
      const result: RunResult = { ...ran, exchanges };
      this.host.emit(`exchange:${result.status}`, {
        id: ex.id,
        route: route.spec.id,
      });
      return result;
    } catch (e) {
      const primary = fault(route.spec.owner, "EXECUTION", e);
      if (told.has(primary)) {
        // Already rung, above.
      } else if (run.kind !== "errorChannel") {
        const parked = await parkFromFailure(primary);
        if (parked) return parked;
      } else await this.handlers(route.spec, "error", ex, run.kind, primary);
      this.host.emit("exchange:failed", {
        plugin: primary.plugin,
        message: primary.message,
      });
      throw primary;
    }
  }
  private async execute(route: Compiled, run: Run): Promise<RunResult> {
    if (run.error) throw run.error;
    const queue: {
      ex: Exchange;
      pending: readonly string[];
      /** A fan-out child: nothing could revive it alone, so it may not park. */
      fanned?: boolean;
    }[] = [{ ex: run.exchange, pending: run.pending }];
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
              nested: true,
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
          invoke: async (point, exchange) => {
            const ring = await this.handlers(
              route.spec,
              point,
              exchange,
              run.kind,
            );
            return ring.kind === "allow" ? ring.exchange : null;
          },
        };
        const given = this.attach(wireExchange(ex));
        try {
          const outcome = await abortable(
            this.own(Promise.resolve().then(() => step.execute(given, ctx))),
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
                  fanned: true,
                });
              pending = [];
              break;
            case "defer": {
              // Nothing could revive a path the parent step is still running; refused before anything is written.
              if (run.nested) throw new Fault(step.owner, "DEFER_IN_PATH", id);
              if (item.fanned)
                throw new Fault(step.owner, "DEFER_IN_FANOUT", id);
              const reenter = outcome.request.reenter === true;
              const remaining = reenter ? [id, ...pending] : pending;
              deferrals.push(
                await this.park(
                  route,
                  outcome.exchange,
                  id,
                  reenter,
                  remaining,
                  outcome.request,
                  step.owner,
                ),
              );
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
          const f = fault(step.owner, "STEP", e);
          // The site travels with the failure so an error handler may park the exchange exactly where it failed.
          if (!run.nested && !item.fanned && !f.site)
            f.site = { step: id, exchange: given, pending: [...pending] };
          throw f;
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
   * for. A sweep in flight ends between records and may still deliver the
   * one it claimed.
   */
  async stop(timeout = 30_000) {
    this.#accept = false;
    this.#draining = true;
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
    this.#draining = false;
    errors.push(...(await this.host.dispose()));
    if (errors.length)
      throw new AggregateError(errors, errors.map((e) => e.message).join("\n"));
  }
}
