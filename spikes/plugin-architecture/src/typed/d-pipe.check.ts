import { filter, type Flow, pipe, source, transform } from "./d-pipe.ts";

type Expect<T extends true> = T;
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type BodyOf<F> = F extends Flow<infer B> ? B : never;

export const route = pipe(
  source<{ subject: string; size: number }>("mail"),
  transform((mail) => mail.subject),
  filter((subject) => subject.length > 0),
  transform((subject) => subject.length),
);

export type PipeFlowsTheBodyType = Expect<Equals<BodyOf<typeof route>, number>>;
