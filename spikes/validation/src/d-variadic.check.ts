import { chainBroken, type Flow, source, start } from "./d-variadic.ts";

type Expect<T extends true> = T;
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type BodyOf<F> = F extends Flow<infer B> ? B : never;

/**
 * Checked negative: the single variadic signature type-checks when every
 * lambda is annotated, but it cannot CONTEXTUALLY TYPE them, because `Fns`
 * and `Threaded<Fns, In>` are mutually dependent so `Fns` infers as the
 * empty tuple. An unannotated parameter therefore falls to implicit `any`.
 * That is the real limitation, and it is what an overload set buys.
 */
chainBroken(
  source<{ subject: string }>("mail"),
  // @ts-expect-error `mail` is implicitly `any`: no contextual type reaches it.
  (mail) => mail.subject,
);
/** Curried: eight operators, one signature, every parameter inferred. */
export const long = start(source<{ subject: string; size: number }>("mail"))(
  (mail) => mail.subject,
)((subject) => subject.length)((size) => size > 3)((flag) =>
  flag ? "big" : "small",
)((label) => ({ label }))((wrapped) => wrapped.label.length)((n) => [n])(
  (xs) => xs.length,
).done();

export type EightDeepBodyFlows = Expect<Equals<BodyOf<typeof long>, number>>;
