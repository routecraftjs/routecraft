import type { Exchange, Step } from "../contracts/index.ts";

/**
 * Encoding D: operators are free functions and the route is a pipe.
 *
 * No global interface, no prototype patching, no proxy, no declaration
 * merging. A plugin ships an ordinary exported function and TypeScript's
 * normal inference does the rest, so the declaration and the implementation
 * are one thing and cannot drift.
 *
 * The cost is the fluent chain, which is the framework's most recognisable
 * surface.
 */

export interface Flow<Body> {
  readonly steps: readonly Step[];
  readonly __body?: Body;
}

export type Operator<In, Out> = (flow: Flow<In>) => Flow<Out>;

export function source<Body>(label: string): Flow<Body> {
  return { steps: [{ label, run: () => {} }] };
}

function append<In, Out>(flow: Flow<In>, step: Step): Flow<Out> {
  return { steps: [...flow.steps, step] };
}

// --- what a plugin ships: ordinary exported functions -------------------

export function transform<In, Out>(fn: (body: In) => Out): Operator<In, Out> {
  return (flow) =>
    append(flow, {
      label: "transform",
      run: (ex: Exchange) => void (ex.body = fn(ex.body as In)),
    });
}

export function filter<Body>(
  predicate: (body: Body) => boolean,
): Operator<Body, Body> {
  return (flow) =>
    append(flow, {
      label: "filter",
      run: (ex: Exchange) =>
        void (ex.headers["filtered"] = !predicate(ex.body as Body)),
    });
}

// --- the pipe -----------------------------------------------------------

export function pipe<A, B>(a: Flow<A>, ab: Operator<A, B>): Flow<B>;
export function pipe<A, B, C>(
  a: Flow<A>,
  ab: Operator<A, B>,
  bc: Operator<B, C>,
): Flow<C>;
export function pipe<A, B, C, D>(
  a: Flow<A>,
  ab: Operator<A, B>,
  bc: Operator<B, C>,
  cd: Operator<C, D>,
): Flow<D>;
export function pipe(
  start: Flow<unknown>,
  ...operators: ReadonlyArray<Operator<unknown, unknown>>
): Flow<unknown> {
  return operators.reduce((flow, op) => op(flow), start);
}
