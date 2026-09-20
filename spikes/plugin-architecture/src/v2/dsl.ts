import {
  Fault,
  fault,
  type Installation,
  type FacetFactories,
  type Exchange,
  type Step,
  type Source,
  type RouteSpec,
  type StepContext,
  type StepOutcome,
} from "./contracts.ts";
import { Host } from "./host.ts";
import { Runtime } from "./runtime.ts";
export type Phase = "before" | "after";
export interface Family {
  readonly Body: unknown;
  readonly Plugins: readonly Plugin[];
  readonly Headers: object;
  readonly Phase: Phase;
  readonly methods: object;
}
export type Apply<
  F extends Family,
  B,
  P extends readonly Plugin[],
  H extends object,
  S extends Phase,
> = (F & { Body: B; Plugins: P; Headers: H; Phase: S })["methods"];
export interface Plugin<
  F extends Family = Family,
  V extends FacetFactories = FacetFactories,
> extends Installation {
  readonly facets: V;
  methods<B, P extends readonly Plugin[], H extends object, S extends Phase>(
    cursor: Cursor<B, P, H, S>,
  ): Apply<F, B, P, H, S>;
}
type Intersect<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;
type Boxes<
  P extends readonly Plugin[],
  B,
  H extends object,
  S extends Phase,
> = Intersect<
  {
    [K in keyof P]: {
      methods: P[K] extends Plugin<infer F> ? Apply<F, B, P, H, S> : never;
    };
  }[number]
>;
type Methods<
  P extends readonly Plugin[],
  B,
  H extends object,
  S extends Phase,
> = Boxes<P, B, H, S> extends { methods: infer M } ? M : object;
type OneFacet<E> =
  E extends Plugin<Family, infer V>
    ? { readonly [N in keyof V]: ReturnType<V[N]> }
    : object;
type TupleKeys<P> = Exclude<keyof P, keyof (readonly unknown[])>;
type FacetBox<P extends readonly Plugin[]> = Intersect<
  { [K in TupleKeys<P>]: { facets: OneFacet<P[K]> } }[TupleKeys<P>]
>;
export type Facets<P extends readonly Plugin[]> =
  FacetBox<P> extends { facets: infer V } ? V : object;
export type TypedExchange<
  B,
  P extends readonly Plugin[],
  H extends object,
> = Exchange<B, Partial<H>> & Facets<P>;
export type Chain<
  B,
  P extends readonly Plugin[],
  H extends object,
  S extends Phase,
> = P extends unknown ? Cursor<B, P, H, S> & Methods<P, B, H, S> : never;
export type StepWrapper = (step: Step) => Step;
export interface Plan {
  readonly spec: RouteSpec;
  readonly pending: readonly StepWrapper[];
  readonly phase: Phase;
}
/** Public compiler cursor: operations need no private symbols. */
export class Cursor<
  B,
  P extends readonly Plugin[],
  H extends object,
  S extends Phase,
> {
  constructor(
    private readonly app: Application<P>,
    readonly plan: Plan,
    readonly owner: string,
  ) {}
  get phase(): S {
    return this.plan.phase as S;
  }
  configure(options: Record<string, unknown>): Chain<B, P, H, S> {
    return assemble(this.app, {
      ...this.plan,
      spec: {
        ...this.plan.spec,
        options: { ...this.plan.spec.options, ...options },
      },
    });
  }
  from<T>(
    this: Cursor<B, P, H, "before">,
    source: Source<T>,
  ): Chain<T, P, H, "after"> {
    if (this.plan.phase !== "before")
      throw new Fault(this.owner, "DSL_PHASE", "from");
    return assemble(this.app, {
      ...this.plan,
      phase: "after",
      spec: { ...this.plan.spec, source: source as Source },
    });
  }
  wrap(wrapper: StepWrapper): Chain<B, P, H, S> {
    return assemble(this.app, {
      ...this.plan,
      pending: [...this.plan.pending, wrapper],
    });
  }
  #append<R = B>(step: Step): Chain<R, P, H, "after"> {
    if (this.plan.phase !== "after")
      throw new Fault(this.owner, "DSL_PHASE", "step before from");
    let wrapped = step;
    for (const w of [...this.plan.pending].reverse()) wrapped = w(wrapped);
    return assemble(this.app, {
      phase: "after",
      pending: [],
      spec: { ...this.plan.spec, steps: [...this.plan.spec.steps, wrapped] },
    });
  }
  map<R>(
    fn: (body: B, exchange: TypedExchange<B, P, H>, context: StepContext) => R,
  ): Chain<Awaited<R>, P, H, "after"> {
    const step: Step = {
      id: `${this.owner}:transform:${this.plan.spec.steps.length}`,
      owner: this.owner,
      version: "1",
      execute: async (ex, ctx) => ({
        kind: "continue",
        exchange: {
          ...ex,
          body: await fn(ex.body as B, ex as TypedExchange<B, P, H>, ctx),
        },
      }),
    };
    return this.#append<Awaited<R>>(step);
  }
  step(
    id: string,
    execute: (
      ex: TypedExchange<B, P, H>,
      ctx: StepContext,
    ) => StepOutcome<B> | Promise<StepOutcome<B>>,
    children: readonly Step[] = [],
  ): Chain<B, P, H, "after"> {
    return this.#append({
      id,
      owner: this.owner,
      version: "1",
      children,
      execute: (ex, ctx) => execute(ex as TypedExchange<B, P, H>, ctx),
    });
  }
  build(this: Cursor<B, P, H, "after">): RouteSpec {
    if (this.plan.pending.length)
      throw new Fault(this.owner, "DANGLING_WRAPPER", this.plan.spec.id);
    return this.plan.spec;
  }
}
function assemble<
  B,
  P extends readonly Plugin[],
  H extends object,
  S extends Phase,
>(app: Application<P>, plan: Plan): Chain<B, P, H, S> {
  const host = new Cursor<B, P, H, S>(app, plan, "application");
  const owners = new Map<PropertyKey, string>();
  for (const plugin of app.plugins) {
    let methods: object;
    try {
      methods = plugin.methods(new Cursor<B, P, H, S>(app, plan, plugin.id));
    } catch (e) {
      throw fault(plugin.id, "DSL_BIND", e);
    }
    const seen = new Set<PropertyKey>();
    for (
      let proto: object | null = methods;
      proto && proto !== Object.prototype;
      proto = Object.getPrototypeOf(proto) as object | null
    )
      for (const key of Reflect.ownKeys(proto)) {
        if (seen.has(key) || (key === "constructor" && proto !== methods))
          continue;
        seen.add(key);
        if (key in host)
          throw new Fault(
            plugin.id,
            "DSL_COLLISION",
            `${String(key)} already owned by ${owners.get(key) ?? "kernel"}`,
          );
        const descriptor = Object.getOwnPropertyDescriptor(proto, key)!;
        if (typeof descriptor.value === "function")
          descriptor.value = descriptor.value.bind(methods);
        if (descriptor.get) descriptor.get = descriptor.get.bind(methods);
        if (descriptor.set) descriptor.set = descriptor.set.bind(methods);
        Object.defineProperty(host, key, descriptor);
        owners.set(key, plugin.id);
      }
  }
  return host as Chain<B, P, H, S>;
}
export interface EmptyFamily extends Family {
  readonly methods: object;
}
export function infrastructure<V extends FacetFactories = Record<never, never>>(
  installation: Installation & { readonly facets?: V },
): Plugin<EmptyFamily, V> {
  return {
    ...installation,
    facets: installation.facets ?? ({} as V),
    methods: () => ({}),
  };
}
export class Application<P extends readonly Plugin[]> {
  readonly host: Host;
  readonly runtime: Runtime;
  readonly plugins: P;
  #boot: Promise<void> | undefined;
  #stop: Promise<void> | undefined;
  constructor(plugins: P) {
    this.plugins = Object.freeze(
      plugins.map((p) =>
        Object.freeze({
          ...p,
          requires: Object.freeze([...(p.requires ?? [])]),
          provides: Object.freeze([...(p.provides ?? [])]),
          replaces: Object.freeze([...(p.replaces ?? [])]),
          facets: Object.freeze({ ...p.facets }),
        }),
      ),
    ) as unknown as P;
    this.host = new Host(this.plugins);
    const facets: Record<string, (ex: Exchange) => unknown> = {};
    const owners = new Map<string, string>();
    for (const plugin of this.plugins)
      for (const [key, factory] of Object.entries(plugin.facets)) {
        if (
          ["body", "id", "routeId", "headers", "principal"].includes(key) ||
          key in facets
        )
          throw new Fault(
            plugin.id,
            "FACET_COLLISION",
            `${key}: ${owners.get(key) ?? "kernel"}`,
          );
        facets[key] = (ex) => {
          try {
            return factory(ex, {
              require: (contract) => this.host.requireFor(plugin.id, contract),
            });
          } catch (e) {
            throw fault(plugin.id, "FACET", e);
          }
        };
        owners.set(key, plugin.id);
      }
    this.runtime = new Runtime(this.host, facets);
  }
  route<H extends object = Record<string, unknown>>(
    id: string,
    version = "1",
    tags: readonly string[] = [],
  ): Chain<unknown, P, H, "before"> {
    return assemble(this, {
      phase: "before",
      pending: [],
      spec: { id, owner: "application", version, tags, steps: [] },
    });
  }
  start(routes: readonly RouteSpec[]): Promise<void> {
    if (this.#stop)
      return Promise.reject(
        new Fault("application", "LIFECYCLE", "single-use context has stopped"),
      );
    return (this.#boot ??= (async () => {
      try {
        await this.host.bind();
        for (const route of routes) this.runtime.compile(route);
        await this.runtime.start();
      } catch (e) {
        const f = fault("application", "BOOT", e);
        f.secondary.push(...(await this.host.dispose()));
        throw f;
      }
    })());
  }
  stop(): Promise<void> {
    return (this.#stop ??= (async () => {
      try {
        await this.#boot;
      } catch {
        /* boot already unwound */
      }
      await this.runtime.stop();
    })());
  }
}
export function application<const P extends readonly Plugin[]>(
  plugins: P & (number extends P["length"] ? never : unknown),
): Application<P> {
  return new Application(plugins);
}
