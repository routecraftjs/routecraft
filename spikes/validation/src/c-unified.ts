/**
 * Awkward thing (c): steps are declarative data on the plugin while wrappers
 * are imperative `ctx.contribute` calls, which splits the one-interface story.
 *
 * The split is not steps-versus-wrappers. It is "known at module load"
 * versus "known after dependency resolution". A step factory closes over
 * nothing, so it can be a literal; a wrapper closes over the API the plugin
 * built from `ctx.require(...)`, so it cannot.
 *
 * A thunk over the resolved dependencies erases the distinction. Every point
 * becomes declarative data, `apply` disappears from the common case, and the
 * builder type still derives, because `ReturnType` sees through a thunk.
 */
import type {
  Exchange,
  Pipeline,
  RouteView,
  Step,
  Token,
} from "../../plugin-architecture/src/contracts/index.ts";

export interface Wrapper {
  readonly before?: readonly string[];
  readonly after?: readonly string[];
  wrap(next: Pipeline, route: RouteView): Pipeline;
}

export type Handler = (
  exchange: Exchange,
  error?: unknown,
) => void | Promise<void>;

/** What a plugin declares it needs, by token, resolved before anything else. */
export type Needs = Readonly<Record<string, Token<unknown>>>;

export type Resolved<N extends Needs> = {
  readonly [K in keyof N]: N[K] extends Token<infer T> ? T : never;
};

/**
 * One shape for every point. `setup` runs once after dependencies resolve
 * and returns the plugin's own value; every contribution is a thunk over
 * that value plus the resolved dependencies.
 */
export interface PluginSpec<
  N extends Needs,
  Self,
  Steps extends Readonly<Record<string, (...args: never[]) => Step>>,
> {
  readonly id: string;
  readonly needs?: N;
  readonly provides?: Token<Self>;
  setup(deps: Resolved<N>): Self;
  readonly steps?: (self: Self) => Steps;
  readonly wrappers?: (self: Self) => Readonly<Record<string, Wrapper>>;
  readonly handlers?: (
    self: Self,
  ) => Readonly<
    Record<string, { point: "entry" | "error" | "complete"; handle: Handler }>
  >;
  readonly exchange?: (
    self: Self,
  ) => Readonly<Record<string, (ex: Exchange) => unknown>>;
  readonly start?: (self: Self) => void | Promise<void>;
  readonly stop?: (self: Self) => void | Promise<void>;
  readonly health?: (self: Self) => { up: boolean };
}

export function definePlugin<
  const N extends Needs,
  Self,
  const Steps extends Readonly<Record<string, (...args: never[]) => Step>>,
>(spec: PluginSpec<N, Self, Steps>): PluginSpec<N, Self, Steps> {
  return spec;
}

/** The builder derives through the thunk, which is the thing worth proving. */
export type StepsOfUnified<Plugins extends readonly unknown[]> =
  Plugins extends readonly [infer Head, ...infer Tail]
    ? StepsOfOne<Head> & StepsOfUnified<Tail>
    : Record<never, never>;

type StepsOfOne<P> = P extends { readonly steps?: infer F }
  ? NonNullable<F> extends (self: never) => infer S
    ? S
    : Record<never, never>
  : Record<never, never>;

export type UnifiedBuilder<Steps> = {
  [K in keyof Steps]: Steps[K] extends (...args: infer A) => Step
    ? (...args: A) => UnifiedBuilder<Steps>
    : never;
} & { build(): readonly Step[] };
