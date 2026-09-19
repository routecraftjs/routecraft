import type { Exchange, Step } from "../contracts/index.ts";

/**
 * Encoding C: thread the body type through a merged interface's type
 * parameter, which is what `StepBuilderBase<S extends BuilderState>` does in
 * the framework today.
 *
 * The plugin author writes the whole signature, including the return type,
 * so the body relationship survives. This is the only encoding tried here
 * that keeps a fluent chain AND a flowing body type AND plugin extension.
 * It is also the one the spike proved unsound (S1): the declaration and the
 * registration are two halves with nothing correlating them.
 */

export interface StepRegistry<Body> {
  // Augmented by plugins. Empty here on purpose.
  readonly __body?: Body;
}

export type Chain<Body> = StepRegistry<Body> & {
  steps(): readonly Step[];
  bodyType(): Body;
};

const REGISTERED = new Map<string, (...args: never[]) => Step>();

export function registerStep(
  name: string,
  factory: (...args: never[]) => Step,
): void {
  if (REGISTERED.has(name)) throw new Error(`"${name}" already registered`);
  REGISTERED.set(name, factory);
}

export function chain<Body>(): Chain<Body> {
  const steps: Step[] = [];
  const proxy = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "steps") return () => steps;
        if (property === "bodyType") return () => undefined;
        const factory = REGISTERED.get(String(property));
        if (factory === undefined) return undefined;
        return (...args: never[]) => {
          steps.push(factory(...args));
          return proxy;
        };
      },
    },
  ) as Chain<Body>;
  return proxy;
}

// --- what a plugin ships -----------------------------------------------

declare module "./c-merged.ts" {
  interface StepRegistry<Body> {
    transform<R>(fn: (body: Body) => R): Chain<R>;
    filter(predicate: (body: Body) => boolean): Chain<Body>;
  }
}

registerStep("transform", ((fn: (b: unknown) => unknown) => ({
  label: "transform",
  run: (ex: Exchange) => void (ex.body = fn(ex.body)),
})) as (...args: never[]) => Step);

registerStep("filter", ((predicate: (b: unknown) => boolean) => ({
  label: "filter",
  run: (ex: Exchange) => void (ex.headers["filtered"] = !predicate(ex.body)),
})) as (...args: never[]) => Step);
