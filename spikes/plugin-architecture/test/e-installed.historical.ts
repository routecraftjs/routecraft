import { expect, test } from "bun:test";
import { from, operations, stranger } from "../src/typed/e-installed.ts";
import { route } from "../src/typed/e-installed.check.ts";
/**
 * @case E: installed, fluent, inferred generic body transforms execute
 * @preconditions Operations and stranger are installed; inferred transforms surround pair.
 * @expectedResult The executed body is the number 10.
 */
test("E: installed, fluent, inferred generic body transforms execute", async () => {
  expect(await route.run()).toBe(10);
});
/**
 * @case E: immutable siblings retain their own body types and execution
 * @preconditions A base chain and a derived numeric chain are retained.
 * @expectedResult Both execute independently with their originally inferred body types.
 */
test("E: immutable siblings retain their own body types and execution", async () => {
  const base = from("hello", [operations, stranger]);
  const length = base.transform((s) => s.length);
  expect(await base.pair().run()).toEqual(["hello", "hello"]);
  expect(await length.run()).toBe(5);
});
/**
 * @case E: duplicate methods fail at construction
 * @preconditions The same method-bearing plugin is installed twice.
 * @expectedResult Construction rejects the method collision.
 */
test("E: duplicate methods fail at construction", () => {
  expect(() => from("hi", [operations, operations])).toThrow("DSL collision");
});
/**
 * @case E: unlimited fluent through requires no pipe arity overload
 * @preconditions Six through calls compose inline inferred functions.
 * @expectedResult The final value is the string 5 without arity overloads.
 */
test("E: unlimited fluent through requires no pipe arity overload", async () => {
  const flow = from(0, [])
    .through((x) => x.map((n) => n + 1))
    .through((x) => x.map((n) => n + 1))
    .through((x) => x.map((n) => n + 1))
    .through((x) => x.map((n) => n + 1))
    .through((x) => x.map((n) => n + 1))
    .through((x) => x.map((n) => String(n)));
  const result: string = await flow.run();
  expect(result).toBe("5");
});
/**
 * @case E: async transform awaits its output before inferring the next body
 * @preconditions A promise source is followed by async and synchronous transforms.
 * @expectedResult The second callback receives a string and the route returns the number 4.
 */
test("E: async transform awaits its output before inferring the next body", async () => {
  const result = from(Promise.resolve({ name: "test" }), [operations, stranger])
    .transform(async (x) => x.name)
    .transform((x) => x.length);
  const n: number = await result.run();
  expect(n).toBe(4);
});
/**
 * @case E: forty installed plugin method families retain inference and execute
 * @preconditions Forty distinct method-family plugins are installed and invoked.
 * @expectedResult The complete chain typechecks and executes to the number 5.
 */
test("E: forty installed plugin method families retain inference and execute", async () => {
  const { check } = await import("../src/typed/e-scale.check.ts");
  expect(await check).toBe(5);
});
/**
 * @case E: checked class implementations install prototype methods too
 * @preconditions A checked plugin returns a class instance with a prototype method.
 * @expectedResult The inherited method is installed and produces the expected tuple.
 */
test("E: checked class implementations install prototype methods too", async () => {
  const classPlugin: import("../src/typed/e-installed.ts").Extension<
    import("../src/typed/e-installed.ts").StrangerFamily
  > = {
    name: "class",
    create: <
      B,
      P extends readonly import("../src/typed/e-installed.ts").Extension[],
    >(
      host: import("../src/typed/e-installed.ts").Cursor<B, P>,
    ) =>
      new (class {
        pair() {
          return host.map((body) => [body, body] as const);
        }
      })(),
  };
  expect(await from("x", [classPlugin]).pair().run()).toEqual(["x", "x"]);
});
