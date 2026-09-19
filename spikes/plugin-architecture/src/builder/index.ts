import type { Step } from "../contracts/index.ts";
import type { Kernel } from "../kernel/index.ts";
import type { RouteSpec } from "../runtime/index.ts";

/**
 * Three candidate answers to the hardest question in the design: how does a
 * step contributed by a plugin become a typed method on the builder?
 *
 * Only one of them survives, and it is the one the framework already uses.
 * See README, SPIKE-F3.
 */

// ---------------------------------------------------------------------------
// Candidate A: string-keyed. Types work, ergonomics die.
// ---------------------------------------------------------------------------

export class KeyedBuilder {
  readonly #steps: Array<readonly [string, ...unknown[]]> = [];
  constructor(
    private readonly kernel: Kernel,
    private readonly id: string,
  ) {}

  step(name: string, ...args: unknown[]): this {
    this.#steps.push([name, ...args]);
    return this;
  }

  build(): RouteSpec {
    return {
      id: this.id,
      source: { label: "none", subscribe: () => Promise.resolve(() => {}) },
      steps: this.#steps,
    };
  }
}

// ---------------------------------------------------------------------------
// Candidate B: declaration merging, which is what `registerDsl` does today.
// The method is patched onto the prototype at runtime and declared
// separately; the two are correlated by convention and by nothing else.
// ---------------------------------------------------------------------------

export interface BuilderState {
  body: unknown;
}

export type Retyped<B, S extends BuilderState> =
  B extends FluentBuilder<BuilderState> ? FluentBuilder<S> : never;

export type SetBody<S extends BuilderState, B> = Omit<S, "body"> & { body: B };

export class FluentBuilder<S extends BuilderState> {
  readonly steps: Step[] = [];
  declare readonly __state: S;

  push(step: Step): this {
    this.steps.push(step);
    return this;
  }
}

/** The runtime half. A plugin calls this from `apply`. */
export function registerFluent(
  name: string,
  factory: (...args: readonly unknown[]) => Step,
): void {
  const proto = FluentBuilder.prototype as unknown as Record<string, unknown>;
  if (name in proto) throw new Error(`"${name}" already on the builder`);
  proto[name] = function (
    this: FluentBuilder<BuilderState>,
    ...args: unknown[]
  ) {
    return this.push(factory(...args));
  };
}

// The type half, written by the plugin author in its own package. Nothing
// checks that the two halves agree.
declare module "./index.ts" {
  interface FluentBuilder<S extends BuilderState> {
    upper(): Retyped<this, SetBody<S, string>>;
  }
}

registerFluent("upper", () => ({
  label: "upper",
  run: (ex) => void (ex.body = String(ex.body).toUpperCase()),
}));

// ---------------------------------------------------------------------------
// Candidate C: infer the builder's methods from the installed plugin set, so
// there is no second half to drift. A plugin declares its steps in its TYPE
// rather than only registering them at runtime.
// ---------------------------------------------------------------------------

export type StepFactories = Record<string, (...args: never[]) => Step>;

export interface TypedPlugin<Steps extends StepFactories = StepFactories> {
  readonly id: string;
  readonly dependsOn?: readonly string[];
  /** Declared in the type, so the builder can be derived from it. */
  readonly steps?: Steps;
}

/** Union of every installed plugin's step map. */
export type StepsOf<Plugins extends readonly TypedPlugin[]> =
  Plugins extends readonly [infer Head, ...infer Tail]
    ? Head extends TypedPlugin<infer S>
      ? Tail extends readonly TypedPlugin[]
        ? S & StepsOf<Tail>
        : S
      : Record<never, never>
    : Record<never, never>;

/** A builder whose methods are exactly the installed steps. */
export type DerivedBuilder<Steps> = {
  [K in keyof Steps]: Steps[K] extends (...args: infer A) => Step
    ? (...args: A) => DerivedBuilder<Steps>
    : never;
} & { build(): readonly Step[] };

export function derivedBuilder<const Plugins extends readonly TypedPlugin[]>(
  plugins: Plugins,
): DerivedBuilder<StepsOf<Plugins>> {
  const steps: Step[] = [];
  const registry = new Map<string, (...args: never[]) => Step>();
  for (const plugin of plugins) {
    for (const [name, factory] of Object.entries(plugin.steps ?? {})) {
      registry.set(name, factory);
    }
  }
  const proxy = new Proxy(
    { build: () => steps },
    {
      get(target, property) {
        if (property === "build") return () => steps;
        const factory = registry.get(String(property));
        if (factory === undefined) return undefined;
        return (...args: never[]) => {
          steps.push(factory(...args));
          return proxy;
        };
      },
    },
  );
  return proxy as DerivedBuilder<StepsOf<Plugins>>;
}

/** A plugin that declares its steps in its type. */
export const typedOperations = {
  id: "routecraft.operations",
  steps: {
    transform: (fn: (body: unknown) => unknown): Step => ({
      label: "transform",
      run: (ex) => void (ex.body = fn(ex.body)),
    }),
  },
} as const satisfies TypedPlugin;

export const typedDeferral = {
  id: "routecraft.deferral",
  dependsOn: ["routecraft.stores"],
  steps: {
    defer: (reason: string): Step => ({
      label: "defer",
      run: (ex) => void (ex.headers["deferred"] = reason),
    }),
  },
} as const satisfies TypedPlugin;
