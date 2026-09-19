/**
 * Awkward thing (d): `pipe` needing an overload per arity.
 *
 * Three formulations, with `tsc` as the arbiter.
 *
 *  1. `chainBroken` — one variadic signature threading the body through a
 *     mapped tuple. It does NOT work: `Fns` and `Threaded<Fns, In>` are
 *     mutually dependent, so `Fns` infers as the empty tuple and every
 *     lambda parameter falls back to implicit `any`. Recorded as a checked
 *     negative in `d-variadic.check.ts` so the limitation is verified rather
 *     than assumed, and so a future TypeScript that fixes it breaks loudly.
 *
 *  2. `step` — the curried form. Unbounded arity, one signature, every
 *     parameter contextually typed, and sound. The cost is one `.done()`
 *     and a call per operator instead of a comma.
 *
 * The third answer is that (d) is a question about encoding D only. Encoding
 * E in `e-hkt.ts` has unbounded arity with no overloads and no currying,
 * because a method chain does not have an arity.
 */
import type {
  Exchange,
  Step,
} from "../../plugin-architecture/src/contracts/index.ts";

export interface Flow<Body> {
  readonly steps: readonly Step[];
  readonly __body?: Body;
}

export function source<Body>(label: string): Flow<Body> {
  return { steps: [{ label, run: () => {} }] };
}

// --- formulation 1: the variadic mapped tuple, which does not work --------

type Threaded<Fns extends readonly unknown[], In> = Fns extends readonly [
  unknown,
  ...infer Rest,
]
  ? readonly [(body: In) => unknown, ...Threaded<Rest, ReturnOf<Fns[0], In>>]
  : readonly [];

type ReturnOf<F, In> = F extends (body: never) => infer R ? R : In;

export declare function chainBroken<In, const Fns extends readonly unknown[]>(
  start: Flow<In>,
  ...fns: Fns & Threaded<Fns, In>
): Flow<unknown>;

// --- formulation 2: curried, unbounded, one signature, fully inferred -----

export interface Curried<Body> {
  <Out>(fn: (body: Body) => Out): Curried<Out>;
  done(): Flow<Body>;
}

export function start<Body>(from: Flow<Body>): Curried<Body> {
  const make = <B>(flow: Flow<B>): Curried<B> => {
    const next = <Out>(fn: (body: B) => Out): Curried<Out> =>
      make<Out>({
        steps: [
          ...flow.steps,
          {
            label: "transform",
            run: (ex: Exchange) => void (ex.body = fn(ex.body as B)),
          },
        ],
      });
    next.done = (): Flow<B> => flow;
    return next as Curried<B>;
  };
  return make(from);
}
