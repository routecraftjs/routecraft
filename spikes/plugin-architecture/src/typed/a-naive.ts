import type { Step } from "../contracts/index.ts";

/**
 * Encoding A: the obvious one. A step factory is a generic function and the
 * builder infers its input and output body types from the signature.
 *
 * This is what you write first. It does not work, and the reason is a hard
 * limit of the language rather than a detail: `infer` against a generic
 * function instantiates its type parameters at their constraints, so the
 * relationship between the step's input and output body is erased at exactly
 * the point the builder needs it.
 */

export interface TypedStep<In, Out> extends Step {
  readonly __in?: In;
  readonly __out?: Out;
}

export type StepFactories = Record<
  string,
  (...args: never[]) => TypedStep<unknown, unknown>
>;

export const naiveOperations = {
  transform: <B, R>(fn: (body: B) => R): TypedStep<B, R> => ({
    label: "transform",
    run: (ex) => void (ex.body = fn(ex.body as B)),
  }),
};

/** What the builder would have to be. */
export type NaiveBuilder<Steps extends StepFactories, Body> = {
  [K in keyof Steps]: Steps[K] extends (
    ...args: infer A
  ) => TypedStep<unknown, infer Out>
    ? (...args: A) => NaiveBuilder<Steps, Out>
    : never;
} & { body(): Body };

/**
 * The failure, made visible. `Out` infers as `unknown` because `transform`'s
 * `R` is instantiated at its constraint during the conditional check, so the
 * chain loses the body type at the first step.
 */
export type AfterTransform = NaiveBuilder<
  typeof naiveOperations,
  string
>["transform"] extends (
  ...args: never[]
) => NaiveBuilder<typeof naiveOperations, infer Out>
  ? Out
  : never;
