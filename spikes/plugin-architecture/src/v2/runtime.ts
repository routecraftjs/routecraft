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
  type HandlerPoints,
  type RunKind,
  type RouteStatus,
  type FacetFactories,
  type Principal,
  type Continuation,
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
export function wireExchange(ex: Exchange): Exchange {
  return structuredClone({
    id: ex.id,
    routeId: ex.routeId,
    body: ex.body,
    headers: ex.headers,
    principal: ex.principal,
  });
}
interface Compiled {
  spec: RouteSpec;
  steps: Map<string, Step>;
  initial: readonly string[];
  hash: string;
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
  constructor(
    readonly host: Host,
    readonly facets: FacetFactories = {},
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
    const ordered = this.host.ordered(this.host.contributions);
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          version: spec.version,
          steps: [...steps.values()].map((s) => [
            s.id,
            s.owner,
            s.version,
            s.children?.map((c) => c.id),
          ]),
          chain: ordered.map((c) => [c.owner, c.id, c.kind, c.survival]),
          options: spec.options ?? {},
        }),
      )
      .digest("hex");
    const compiled: Compiled = {
      spec: frozen,
      steps,
      initial: initial.map((s) => s.id),
      hash,
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
            const stop = await source.subscribe((body, principal) =>
              this.deliver(route.spec.id, body, principal),
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
      if (name in ex) throw new Fault("kernel", "FACET_COLLISION", name);
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
    principal: Principal = { subject: "anonymous", grants: [], lent: [] },
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
        exchange: { id: randomUUID(), routeId, body, headers: {}, principal },
        kind: "normal",
        signal,
        pending: route.initial,
      }),
    );
  }
  async resume(id: string): Promise<RunResult> {
    if (!this.#accept) throw new Fault("kernel", "NOT_RUNNING", "resume");
    const store = this.host.service(CONTINUATIONS),
      provider = this.host.selected.get(CONTINUATIONS.key)!.plugin.id;
    let saved: Continuation | undefined;
    try {
      saved = await store.read(id);
    } catch (e) {
      throw fault(provider, "READ_CONTINUATION", e);
    }
    if (!saved) throw new Fault(provider, "UNKNOWN_CONTINUATION", id);
    const route = this.route(saved.routeId);
    if (
      saved.codec !== 1 ||
      saved.plan !== route.hash ||
      saved.pending.some((x) => !route.steps.has(x))
    )
      throw new Fault(provider, "PLAN_MISMATCH", id);
    // Current admission is evaluated BEFORE consuming the durable claim. Refusal preserves approval.
    const admitted = await this.handlers(
      route,
      "admission",
      this.attach(wireExchange(saved.exchange)),
      "resume",
    );
    if (!admitted) return { status: "refused", exchanges: [], deferrals: [] };
    let claimed: Continuation | undefined;
    try {
      claimed = await store.claim(id);
    } catch (e) {
      throw fault(provider, "CLAIM", e);
    }
    if (!claimed) throw new Fault(provider, "CLAIM_LOST", id);
    return this.own(
      (async () => {
        try {
          const result = await this.enter(
            route,
            {
              exchange: wireExchange(admitted),
              kind: "resume",
              signal: new AbortController().signal,
              pending: claimed.pending,
            },
            true,
          );
          await store.finish(id, "completed");
          return result;
        } catch (e) {
          try {
            await store.finish(id, "failed");
          } catch (secondary) {
            const f = fault(provider, "RESUME", e);
            f.secondary.push(fault(provider, "FINISH", secondary));
            throw f;
          }
          throw e;
        }
      })(),
    );
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
    const handlers = this.host
      .ordered(this.host.contributions)
      .filter(
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
        const result = await h.handle(ex, error ? { kind, error } : { kind });
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
              const store = this.host.service(CONTINUATIONS);
              const saved: Continuation = {
                codec: 1,
                routeId: route.spec.id,
                plan: route.hash,
                pending: outcome.request.reenter ? [id, ...pending] : pending,
                exchange: wireExchange(outcome.exchange),
              };
              try {
                await store.save(outcome.request.id, saved);
              } catch (e) {
                throw fault(
                  this.host.selected.get(CONTINUATIONS.key)!.plugin.id,
                  "PARK",
                  e,
                );
              }
              deferrals.push(outcome.request.id);
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
        hash: r.hash,
        instructions: [...r.steps.values()].map((s) => ({
          id: s.id,
          owner: s.owner,
          version: s.version,
        })),
        status: r.status,
      })),
    };
  }
  async stop() {
    this.#accept = false;
    const errors: Fault[] = [];
    for (const sub of this.#unsubscribes.splice(0).reverse())
      try {
        await sub.stop();
      } catch (e) {
        errors.push(fault(sub.owner, "UNSUBSCRIBE", e));
      }
    while (this.#work.size) await Promise.allSettled([...this.#work]);
    errors.push(...(await this.host.dispose()));
    if (errors.length)
      throw new AggregateError(errors, errors.map((e) => e.message).join("\n"));
  }
}
