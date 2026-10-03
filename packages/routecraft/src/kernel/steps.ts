import { rcError } from "../error.ts";
import { DefaultExchange, OperationType, type Exchange } from "../exchange.ts";
import {
  toSignalContext,
  type Adapter,
  type Step,
  type StepSignalContext,
} from "../types.ts";
import type { BuilderState, Retyped, SetBody } from "../step-builder-base.ts";

declare const BODY: unique symbol;

/**
 * The body a step is called on, whatever it is.
 *
 * A placeholder for a step factory's types: `step<Body, Body>` with
 * `(fn: (body: Body) => string)` in the factory's arguments gives a
 * body-preserving method whose `fn` is typed at the body the route has when
 * the method is called. At runtime it is whatever the body is.
 */
export interface Body {
  readonly [BODY]: "the body at the call site";
}

declare const STEP_IO: unique symbol;

/**
 * A step that says what body it accepts and what body it leaves. Built by
 * {@link step}; the types exist only for the builder method a plugin's
 * `steps` entry becomes.
 */
export interface TypedStep<In, Out> extends Step<Adapter> {
  readonly [STEP_IO]?: { readonly in: In; readonly out: Out };
}

/** What a plugin's `steps` entry is: the method's arguments in, a step out. */
export type StepFactory = (...args: never[]) => Step<Adapter>;

/**
 * Build a typed step.
 *
 * The function form replaces the body with what it returns. The step form
 * wraps a step written against {@link Step} directly, for one that drops,
 * branches or defers rather than continuing.
 *
 * @template In - The body the step accepts; the method exists only on a
 *   route whose body is assignable to it
 * @template Out - The body the route has after the step
 */
export function step<In, Out>(
  execute: (
    exchange: Exchange<In>,
    ctx: StepSignalContext,
  ) => Out | Promise<Out>,
): TypedStep<In, Out>;
export function step<In, Out>(raw: Step<Adapter>): TypedStep<In, Out>;
export function step<In, Out>(
  impl:
    | Step<Adapter>
    | ((exchange: Exchange<In>, ctx: StepSignalContext) => Out | Promise<Out>),
): TypedStep<In, Out> {
  if (typeof impl !== "function") return impl;
  return {
    operation: OperationType.PROCESS,
    adapter: { adapterId: "routecraft.step" },
    async execute(exchange, ctx) {
      const body = await impl(exchange as Exchange<In>, toSignalContext(ctx));
      return {
        kind: "continue",
        exchange: DefaultExchange.rewrap<Out>(exchange, { body }),
      };
    },
  };
}

/**
 * Methods whose types a `steps` entry cannot express: those generic at the
 * call site (`.defer<Schema>()`). A plugin merges its methods in under its
 * namespace, and the `steps` entry of the same name still provides the
 * runtime.
 *
 * ```ts
 * declare module "@routecraft/routecraft" {
 *   interface StepMethods<S extends BuilderState, This> {
 *     acme: { pick<K extends keyof S["body"]>(key: K): Retyped<This, SetBody<S, S["body"][K]>> };
 *   }
 * }
 * ```
 *
 * @template S - The route's state at the call
 * @template This - The builder the method is called on
 */
export interface StepMethods<S extends BuilderState, This> {
  /** Carries the parameters a merged declaration types its methods with. */
  readonly [STEP_METHOD_TYPES]?: readonly [S, This];
}

declare const STEP_METHOD_TYPES: unique symbol;

/**
 * Facets whose type depends on the route's state, as `ex.deferral.result`
 * depends on the last `.defer({ schema })`. A plugin merges its facet type
 * in under its namespace; otherwise the facet is typed by what `facet`
 * returns.
 *
 * @template S - The route's state where the exchange is read
 */
export interface FacetTypes<S extends BuilderState> {
  /** Carries the parameter a merged declaration types its facet with. */
  readonly [FACET_TYPES]?: S;
}

declare const FACET_TYPES: unique symbol;

type Depth = [never, 0, 1, 2, 3, 4];

/** Whether {@link Body} appears in `T`, a few levels deep. */
type HasBody<T, D extends number = 4> = [D] extends [never]
  ? false
  : 0 extends 1 & T
    ? false
    : T extends Body
      ? true
      : T extends (...args: infer A) => infer R
        ? true extends HasBody<A[number], Depth[D]> | HasBody<R, Depth[D]>
          ? true
          : false
        : T extends object
          ? true extends { [K in keyof T]-?: HasBody<T[K], Depth[D]> }[keyof T]
            ? true
            : false
          : false;

/**
 * `T` with every {@link Body} replaced by `B`, a few levels deep. A type
 * with no placeholder in it is returned as it is, so an output like `Date`
 * or `Order & { gross: number }` keeps its identity.
 */
type Subst<T, B, D extends number = 4> =
  true extends HasBody<T, D> ? SubstIn<T, B, D> : T;

type SubstIn<T, B, D extends number> = [D] extends [never]
  ? T
  : 0 extends 1 & T
    ? T
    : T extends Body
      ? // `Body & { ref: string }` keeps what it adds to the body.
        [Body] extends [T]
        ? B
        : B & Subst<Omit<T, typeof BODY>, B, Depth[D]>
      : T extends Exchange<infer X>
        ? Exchange<Subst<X, B, Depth[D]>>
        : T extends (...args: infer A) => infer R
          ? (...args: Subst<A, B, Depth[D]>) => Subst<R, B, Depth[D]>
          : T extends object
            ? { [K in keyof T]: Subst<T[K], B, Depth[D]> }
            : T;

type UnionToIntersection<U> = (
  U extends unknown ? (k: U) => void : never
) extends (k: infer I) => void
  ? I
  : never;

type LastSegment<S extends string> = S extends `${string}.${infer Rest}`
  ? LastSegment<Rest>
  : S;

/** A plugin's namespace as a type: declared, or the last segment of its id. */
export type NamespaceOf<P> = P extends {
  readonly namespace: infer N extends string;
}
  ? N
  : P extends { readonly id: infer I extends string }
    ? LastSegment<I>
    : never;

type StepMethod<F, S extends BuilderState, This> = F extends (
  ...args: infer A
) => TypedStep<infer In, infer Out>
  ? S["body"] extends Subst<In, S["body"]>
    ? (
        ...args: Subst<A, S["body"]>
      ) => Retyped<This, SetBody<S, Subst<Out, S["body"]>>>
    : never
  : never;

/**
 * The methods a plugin's `steps` become at state `S`: one per entry whose
 * input the body satisfies. Exported so a declaration file can name it.
 */
export type DerivedStepMethods<St, S extends BuilderState, This> = {
  [
    K in keyof St as [StepMethod<St[K], S, This>] extends [never] ? never : K
  ]: StepMethod<St[K], S, This>;
};

type MethodsOfPlugin<P, S extends BuilderState, This> = P extends {
  readonly steps: infer St;
}
  ? NamespaceOf<P> extends keyof StepMethods<S, This>
    ? StepMethods<S, This>[NamespaceOf<P>]
    : DerivedStepMethods<St, S, This>
  : unknown;

/**
 * The step methods the installed plugins add to a builder at state `S`.
 *
 * @template S - The route's state, whose `plugins` field lists the installed
 *   plugin types
 * @template This - The builder the methods return a retyped copy of
 */
export type PluginMethods<S extends BuilderState, This> = UnionToIntersection<
  MethodsOfPlugin<PluginsOf<S>, S, This>
>;

type FacetOfPlugin<P, S extends BuilderState> = P extends {
  readonly facet: (exchange: never) => infer F;
}
  ? {
      readonly [K in NamespaceOf<P>]: K extends keyof FacetTypes<S>
        ? FacetTypes<S>[K]
        : F;
    }
  : unknown;

/**
 * The facets the installed plugins add to an exchange at state `S`:
 * `ex.<namespace>` for each plugin that declares one.
 */
export type FacetsOf<S extends BuilderState> = UnionToIntersection<
  FacetOfPlugin<PluginsOf<S>, S>
>;

/** The installed plugin types a state carries; none when it carries none. */
type PluginsOf<S extends BuilderState> = S extends {
  readonly plugins: infer P;
}
  ? P
  : never;

/**
 * Every plugin step a builder can install, by method name.
 *
 * @internal
 */
export type StepCatalogue = ReadonlyMap<
  string,
  { readonly plugin: string; readonly factory: StepFactory }
>;

/**
 * The step catalogue of a plugin list: every `steps` entry, by name, with
 * the plugin that provides it.
 *
 * @throws RC1116 when two plugins provide a step of the same name
 * @internal
 */
export function catalogueOf(plugins: readonly unknown[]): StepCatalogue {
  const catalogue = new Map<string, { plugin: string; factory: StepFactory }>();
  for (const plugin of plugins) {
    if (typeof plugin !== "object" || plugin === null) continue;
    const { id, steps } = plugin as {
      id?: unknown;
      steps?: Record<string, StepFactory>;
    };
    if (typeof id !== "string" || !steps) continue;
    for (const [name, factory] of Object.entries(steps)) {
      const held = catalogue.get(name);
      if (held && held.plugin !== id) {
        throw rcError("RC1116", undefined, {
          message: `Plugins "${held.plugin}" and "${id}" both provide a step named "${name}". A route method can mean one thing; remove one of the plugins.`,
        });
      }
      catalogue.set(name, { plugin: id, factory });
    }
  }
  return catalogue;
}

/**
 * The plugin types the root `craft()` is typed by: every plugin
 * `@routecraft/routecraft` ships that adds route methods or facets. Each
 * merges itself in under its namespace, so the kernel names none of them.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- filled by declaration merging
export interface ShippedPluginTypes {}

/**
 * The plugin types every application installs by default. A project's
 * `craft()` always has these.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- filled by declaration merging
export interface DefaultPluginTypes {}

/** The union of {@link ShippedPluginTypes}. */
export type ShippedPlugins = ShippedPluginTypes[keyof ShippedPluginTypes];

/** The union of {@link DefaultPluginTypes}. */
export type DefaultPlugins = DefaultPluginTypes[keyof DefaultPluginTypes];

const SHIPPED: unique symbol = Symbol.for("routecraft.shipped-steps");

type GlobalWithShipped = typeof globalThis & {
  [SHIPPED]?: Map<string, Readonly<Record<string, StepFactory>>>;
};

function shipped(): Map<string, Readonly<Record<string, StepFactory>>> {
  return ((globalThis as GlobalWithShipped)[SHIPPED] ??= new Map());
}

/**
 * Make a shipped plugin's steps methods of the root `craft()`. Called by
 * the plugin's module when the package loads; keyed on `Symbol.for` so two
 * copies of the package share one catalogue.
 *
 * @internal
 */
export function registerShippedSteps(
  id: string,
  steps: Readonly<Record<string, StepFactory>>,
): void {
  shipped().set(id, steps);
}

/**
 * The shipped plugins' steps, as plugin-shaped entries for
 * {@link catalogueOf}.
 *
 * @internal
 */
export function shippedSteps(): {
  readonly id: string;
  readonly steps: Readonly<Record<string, StepFactory>>;
}[] {
  return [...shipped()].map(([id, steps]) => ({ id, steps }));
}

/**
 * The step catalogue of every shipped plugin: the root `craft()`'s methods.
 *
 * @internal
 */
export function shippedCatalogue(): StepCatalogue {
  return catalogueOf(shippedSteps());
}
