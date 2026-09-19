import { chain, type Chain } from "./c-merged.ts";

/**
 * Compile-time proof that the body type flows through a chain of
 * plugin-contributed steps under encoding C.
 */
type Expect<T extends true> = T;
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const start = chain<{ subject: string; size: number }>();
const afterTransform = start.transform((mail) => mail.subject);
const afterFilter = afterTransform.filter((subject) => subject.length > 0);
export const afterSecond = afterFilter.transform((subject) => subject.length);

export type BodyFlowsThroughTransform = Expect<
  Equals<ReturnType<typeof afterTransform.bodyType>, string>
>;
export type FilterPreservesBody = Expect<
  Equals<ReturnType<typeof afterFilter.bodyType>, string>
>;
export type SecondTransformRetypes = Expect<
  Equals<ReturnType<typeof afterSecond.bodyType>, number>
>;

/** And the argument is inferred, not annotated. */
export const inferred: Chain<number> = start
  .transform((mail) => mail.size)
  .filter((size) => size > 10);
