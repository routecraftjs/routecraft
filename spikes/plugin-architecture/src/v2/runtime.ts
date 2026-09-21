import { createHash, randomUUID } from "node:crypto";
import { Host, type Owned } from "./host.ts";
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
  type Contribution,
  type HandlerPoints,
  type RunKind,
  type RouteStatus,
  type Continuation,
  type ContinuationRecord,
  type SerializedExchange,
  type SerializedOutcome,
  DEFERRAL_SEQUENCE,
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
/**
 * The plain-JSON form that crosses the store. This is the one boundary that
 * requires it, and it refuses rather than silently dropping a function or
 * stream, naming the step that tried to park it.
 */
function serialize(ex: Exchange, owner: string): SerializedExchange {
  try {
    return structuredClone({
      id: ex.id,
      routeId: ex.routeId,
      body: ex.body,
      headers: ex.headers,
    });
  } catch (e) {
    throw fault(owner, "NOT_SERIALIZABLE", e);
  }
}
/**
 * Hash of the step DEFINITIONS a parked exchange will run when it resumes:
 * ids, owners, versions, declared children, and every value a step names in
 * `source`, with functions taken by verbatim source text. Nothing outside the
 * tail is folded in, so an unrelated plugin or a route option cannot strand
 * every approval in flight, and an edited callable cannot slip under one.
 */
function tailHash(
  steps: ReadonlyMap<string, Step>,
  pending: readonly string[],
) {
  const describe = (step: Step): unknown => [
    step.id,
    step.owner,
    step.version,
    (step.source ?? []).map((v) =>
      typeof v === "function" ? Function.prototype.toString.call(v) : v,
    ),
    step.children?.map(describe) ?? [],
  ];
  return createHash("sha256")
    .update(JSON.stringify(pending.map((id) => describe(steps.get(id)!))))
    .digest("hex");
}
interface Compiled {
  spec: RouteSpec;
  steps: Map<string, Step>;
  initial: readonly string[];
  invoke: Next;
  status: RouteStatus;
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
    const steps = new Map<string, Step>();
    const collect = (list: readonly Step[]): readonly Step[] =>
      Object.freeze(
        list.map((step) => {
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
          const frozen = Object.freeze({
            ...step,
            children: step.children ? collect(step.children) : undefined,
          }) as Step;
          steps.set(step.id, frozen);
          return frozen;
        }),
      );
    const initial = collect(spec.steps);
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
  async resume(
    id: string,
    headers: Record<string, unknown> = {},
  ): Promise<RunResult> {
    if (!this.#accept) throw new Fault("kernel", "NOT_RUNNING", "resume");
    const store = this.host.service(CONTINUATIONS),
      provider = this.host.selected.get(CONTINUATIONS.key)!.plugin.id;
    let record: ContinuationRecord | undefined;
    try {
      record = await store.get(id);
    } catch (e) {
      throw fault(provider, "READ_CONTINUATION", e);
    }
    if (!record) throw new Fault(provider, "UNKNOWN_CONTINUATION", id);
    // An approver double-clicks, a webhook is redelivered: the normal case, answered from the cache.
    if (record.state === "resumed")
      return {
        status: "duplicate",
        exchanges:
          record.outcome?.exchanges.map((x: SerializedExchange) =>
            wireExchange(x),
          ) ?? [],
        deferrals: [],
      };
    if (record.state !== "waiting")
      throw new Fault(provider, "RESUME_SETTLED", `${id}: ${record.state}`);
    const saved = record.continuation;
    const route = this.route(saved.routeId);
    if (
      saved.codec !== 1 ||
      saved.pending.some((x) => !route.steps.has(x)) ||
      saved.tail !== tailHash(route.steps, saved.pending)
    )
      throw new Fault(provider, "PLAN_MISMATCH", id);
    // The ingress headers win: what the resume carries is what is authorised, never what was stored.
    const ingress: Exchange = {
      ...wireExchange(saved.exchange),
      headers: { ...saved.exchange.headers, ...headers },
    };
    // Admission is evaluated BEFORE the record leaves waiting. Refusal preserves the approval.
    const admitted = await this.handlers(
      route,
      "admission",
      this.attach(ingress),
      "resume",
    );
    if (!admitted) return { status: "refused", exchanges: [], deferrals: [] };
    let cas: "won" | "lost";
    try {
      cas = await store.markResumed(id, Date.now());
    } catch (e) {
      throw fault(provider, "MARK_RESUMED", e);
    }
    if (cas === "lost") {
      // Lost the race to another resume: read back and answer as the duplicate it is.
      const settled = await store.get(id);
      if (settled?.state === "resumed")
        return {
          status: "duplicate",
          exchanges:
            settled.outcome?.exchanges.map((x: SerializedExchange) =>
              wireExchange(x),
            ) ?? [],
          deferrals: [],
        };
      throw new Fault(provider, "RESUME_LOST", id);
    }
    return this.own(
      (async () => {
        let result: RunResult;
        try {
          result = await this.enter(
            route,
            {
              exchange: wireExchange(admitted),
              kind: "resume",
              signal: new AbortController().signal,
              pending: saved.pending,
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
        const outcome: SerializedOutcome = {
          status: result.status,
          exchanges: result.exchanges.map((x) => serialize(x, provider)),
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
   * Deliver every due continuation to its route's error channel and settle
   * it expired. The claim is taken first and released by the lease if this
   * process dies mid-delivery, so a nag is re-sent rather than lost, which
   * is the at-least-once trade that is safe for a notification and never
   * for a continuation.
   */
  async sweep(now = Date.now()): Promise<number> {
    if (!this.#accept) throw new Fault("kernel", "NOT_RUNNING", "sweep");
    const store = this.host.service(CONTINUATIONS),
      provider = this.host.selected.get(CONTINUATIONS.key)!.plugin.id;
    let delivered = 0;
    for (const id of await store.findExpired(now)) {
      if ((await store.claimExpiry(id, now)) !== "won") continue;
      const record = await store.get(id);
      if (!record) continue;
      const route = this.route(record.continuation.routeId);
      // The error channel rethrows after the handlers ran; the nag was delivered either way.
      await this.errorChannel(
        route.spec.id,
        wireExchange(record.continuation.exchange),
        new Fault(provider, "EXPIRED", id),
      ).catch(() => undefined);
      if ((await store.markExpired(id)) === "won") delivered++;
    }
    return delivered;
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
  ): Promise<Exchange | null> {
    let ex = exchange;
    const handlers = this.ordered.filter(
      (x): x is Owned<Handler> => x.kind === "handler" && x.point === point,
    );
    for (const h of handlers) {
      if (
        !h.survival[kind] ||
        (h.selector?.routeId && h.selector.routeId !== route.spec.id) ||
        (h.selector?.tag && !route.spec.tags.includes(h.selector.tag))
      )
        continue;
      try {
        const result = await h.handle(
          ex,
          error
            ? { kind, route: route.spec, error }
            : { kind, route: route.spec },
        );
        if (result.kind === "refuse") {
          if (error) continue;
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
      const result = await route.invoke({ ...run, exchange: ex });
      for (const completed of result.exchanges)
        await this.handlers(route, "exit", completed, run.kind);
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
              const store = this.host.service(CONTINUATIONS),
                provider = this.host.selected.get(CONTINUATIONS.key)!.plugin.id;
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
              const remaining = outcome.request.reenter
                ? [id, ...pending]
                : pending;
              const saved: Continuation = {
                codec: 1,
                routeId: route.spec.id,
                tail: tailHash(route.steps, remaining),
                pending: remaining,
                exchange: serialize(parked, step.owner),
                ...(outcome.request.ttl !== undefined
                  ? { expiresAt: Date.now() + outcome.request.ttl }
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
