/**
 * Encoding E: the fluent, body-typed, plugin-extensible builder derived from
 * the installed plugin set, with no declaration merging anywhere.
 *
 * F8 claims a DSL is fluent AND body-typed AND plugin-extensible, or it is
 * sound, but not both. The claim rests on encoding A's failure: `infer`
 * against a generic function instantiates its type parameters at their
 * constraints, so the body relationship is erased.
 *
 * That is true, and it is avoidable. The fix is to stop asking TypeScript to
 * infer a type-level relationship out of a value-level generic function, and
 * to have the plugin state the relationship directly as a defunctionalised
 * type-level function. The parameter list and the resulting body are two
 * computed members on an interface that reads the incoming body through
 * `this`. Nothing is inferred through a generic; everything is applied.
 */
import type {
  Exchange,
  Step,
} from "../../plugin-architecture/src/contracts/index.ts";

/**
 * A step's type-level signature. A plugin extends this and fills in `params`
 * (what the builder method accepts, given the incoming body) and `out` (the
 * outgoing body, given the arguments actually passed).
 */
export interface StepSig {
  /** Incoming body. Supplied by the builder through {@link Apply}. */
  readonly Body: unknown;
  /** Arguments the call site passed. Supplied by the builder. */
  readonly Args: readonly unknown[];
  /** Computed: the parameter list, which may depend on `this["Body"]`. */
  readonly params: readonly unknown[];
  /** Computed: the outgoing body, which may depend on `this["Args"]`. */
  readonly out: unknown;
}

type ParamsOf<S extends StepSig, Body> = (S & {
  readonly Body: Body;
})["params"];

type OutOf<S extends StepSig, Body, Args extends readonly unknown[]> = (S & {
  readonly Body: Body;
  readonly Args: Args;
})["out"];

/** What a plugin ships: one object carrying the runtime AND the type. */
export interface StepDef<S extends StepSig = StepSig> {
  readonly sig?: S;
  make(...args: never[]): Step;
}

export interface TypedPlugin {
  readonly id: string;
  readonly dependsOn?: readonly string[];
  readonly steps: Readonly<Record<string, StepDef>>;
}

/** Merge every installed plugin's step map. Declining removes the key. */
export type StepsOf<Plugins extends readonly TypedPlugin[]> =
  Plugins extends readonly [infer Head, ...infer Tail]
    ? Head extends { readonly steps: infer S }
      ? Tail extends readonly TypedPlugin[]
        ? S & StepsOf<Tail>
        : S
      : Record<never, never>
    : Record<never, never>;

type SigOf<D> = D extends StepDef<infer S> ? S : never;

/** The builder: one method per installed step, body threaded through. */
export type Builder<Steps, Body> = {
  [K in keyof Steps]: <const A extends ParamsOf<SigOf<Steps[K]>, Body>>(
    ...args: A
  ) => Builder<Steps, OutOf<SigOf<Steps[K]>, Body, A>>;
} & {
  build(): readonly Step[];
  bodyType(): Body;
};

export function builder<
  const Plugins extends readonly TypedPlugin[],
  Body = unknown,
>(plugins: Plugins): Builder<StepsOf<Plugins>, Body> {
  const steps: Step[] = [];
  const registry = new Map<string, StepDef>();
  for (const plugin of plugins) {
    for (const [name, def] of Object.entries(plugin.steps)) {
      if (registry.has(name)) {
        throw new Error(`Two plugins contribute the step "${name}"`);
      }
      registry.set(name, def);
    }
  }
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, property) {
        if (property === "build") return () => steps;
        if (property === "bodyType") return () => undefined;
        const def = registry.get(String(property));
        if (def === undefined) return undefined;
        return (...args: never[]) => {
          steps.push(def.make(...args));
          return proxy;
        };
      },
    },
  );
  return proxy as Builder<StepsOf<Plugins>, Body>;
}

// --- what a plugin ships. No `declare module`. No prototype patching. ------

interface TransformSig extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}

interface FilterSig extends StepSig {
  readonly params: [predicate: (body: this["Body"]) => boolean];
  readonly out: this["Body"];
}

interface HeaderSig extends StepSig {
  readonly params: [name: string, value: string];
  readonly out: this["Body"];
}

export const operations = {
  id: "routecraft.operations",
  steps: {
    transform: {
      make: ((fn: (body: unknown) => unknown) => ({
        label: "transform",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<TransformSig>["make"],
    } as StepDef<TransformSig>,
    filter: {
      make: ((p: (body: unknown) => boolean) => ({
        label: "filter",
        run: (ex: Exchange) => void (ex.headers["filtered"] = !p(ex.body)),
      })) as StepDef<FilterSig>["make"],
    } as StepDef<FilterSig>,
    header: {
      make: ((name: string, value: string) => ({
        label: "header",
        run: (ex: Exchange) => void (ex.headers[name] = value),
      })) as StepDef<HeaderSig>["make"],
    } as StepDef<HeaderSig>,
  },
} as const satisfies TypedPlugin;

interface DeferSig extends StepSig {
  readonly params: [reason: string];
  readonly out: this["Body"];
}

export const deferral = {
  id: "routecraft.deferral",
  dependsOn: ["routecraft.stores"],
  steps: {
    defer: {
      make: ((reason: string) => ({
        label: "defer",
        run: (ex: Exchange) => void (ex.headers["deferred"] = reason),
      })) as StepDef<DeferSig>["make"],
    } as StepDef<DeferSig>,
  },
} as const satisfies TypedPlugin;
