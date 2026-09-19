import {
  from,
  operations,
  stranger,
  type Extension,
  type OperationsFamily,
} from "./e-installed.ts";
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;
export const route = from({ subject: "hello", size: 5 }, [operations, stranger])
  .transform((mail) => mail.subject)
  .filter((subject) => subject.length > 0)
  .pair()
  .transform((pair) => pair[0].length + pair[1].length);
export type Inferred = Expect<
  Equal<Awaited<ReturnType<typeof route.run>>, number>
>;
function negatives() {
  const bare = from("hi", [operations]);
  // @ts-expect-error uninstalled plugin has no method
  bare.pair();
  // @ts-expect-error input is inferred as string
  bare.transform((x) => x.missing);
  const ghost: Extension<OperationsFamily> = {
    name: "ghost",
    // @ts-expect-error declared methods cannot be omitted from implementation
    create: () => ({}),
  };
  const wrong: Extension<OperationsFamily> = {
    name: "wrong",
    // @ts-expect-error implementation cannot substitute unrelated return types
    create: () => ({ transform: () => 42, filter: () => 42 }),
  };
  return [ghost, wrong];
}
void negatives;
function dynamicNegative(flag: boolean) {
  const list: Array<typeof operations | typeof stranger> = [operations];
  // @ts-expect-error dynamic plugin arrays need a validated/static facade, not all union members
  from("x", list);
  const choice = flag ? operations : stranger;
  const b = from("x", [choice]);
  // @ts-expect-error a union of possible plugins does not prove that pair is installed
  b.pair();
}
void dynamicNegative;
function tupleUnionNegative(flag: boolean) {
  const plugins = flag ? ([operations] as const) : ([stranger] as const);
  const b = from("x", plugins);
  // @ts-expect-error neither member is guaranteed across both plugin configurations
  b.pair();
}
void tupleUnionNegative;
