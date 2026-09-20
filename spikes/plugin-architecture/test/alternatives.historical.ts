import { expect, test } from "bun:test";
import { withFacets } from "../src/typed/facets.ts";
import { definePlan } from "../src/typed/contribution-plan.ts";
import { anchor, resolveEdges } from "../src/typed/ordering.ts";
import { Kernel } from "../src/kernel/index.ts";
import { Runtime } from "../src/runtime/index.ts";
import type { Exchange } from "../src/contracts/index.ts";
const ex = (): Exchange<string> => ({
  body: "x",
  id: "x",
  routeId: "r",
  headers: {},
  use: () => undefined,
});
/**
 * @case named exchange properties derive from installed factories
 * @preconditions One exchange is built with a deferral factory and another without it.
 * @expectedResult The installed property works, the absent property is rejected by types, and a core-name collision throws.
 */
test("named exchange properties derive from installed factories", () => {
  const rich = withFacets(ex(), {
    deferral: (exchange) => ({
      defer: (reason: string) => `${exchange.id}:${reason}`,
    }),
  });
  expect(rich.deferral.defer("approval")).toBe("x:approval");
  const plain = withFacets(ex(), {});
  // @ts-expect-error no deferral factory installed
  expect(plain.deferral).toBeUndefined();
  expect(() => withFacets(ex(), { body: () => 42 })).toThrow("collision");
});
/**
 * @case steps and wrappers have one declarative binding phase
 * @preconditions A plan declares one step and one wrapper through bind descriptors.
 * @expectedResult Delivery records before, step, after in that order.
 */
test("steps and wrappers have one declarative binding phase", async () => {
  const trace: string[] = [];
  const p = definePlan("one", {
    steps: {
      mark: {
        bind: () => ({
          kind: "step",
          name: "mark",
          factory: () => ({
            label: "mark",
            run: () => {
              trace.push("step");
            },
          }),
        }),
      },
    },
    wrappers: [
      {
        bind: () => ({
          kind: "wrapper",
          id: "around",
          wrap: (next) => async (ex) => {
            trace.push("before");
            await next(ex);
            trace.push("after");
          },
        }),
      },
    ],
  });
  const k = new Kernel([p]);
  await k.start();
  await new Runtime(k).deliver(
    {
      id: "r",
      source: { label: "x", subscribe: async () => () => {} },
      steps: [["mark"]],
    },
    0,
  );
  expect(trace).toEqual(["before", "step", "after"]);
});
/**
 * @case optional ordering tolerates absent owner but detects broken installed contract
 * @preconditions An optional anchor is evaluated with absent, broken, and valid owners.
 * @expectedResult Absence is tolerated, installed missing anchors fail, and a present anchor resolves.
 */
test("optional ordering tolerates absent owner but detects broken installed contract", () => {
  const auth = anchor("auth", "authorize");
  const edges = [{ target: auth, presence: "ifPresent" }] as const;
  expect(resolveEdges(new Set(), new Set(), edges)).toEqual([]);
  expect(() => resolveEdges(new Set(["auth"]), new Set(), edges)).toThrow(
    "auth/authorize",
  );
  expect(resolveEdges(new Set(["auth"]), new Set([auth]), edges)).toEqual([
    auth,
  ]);
  expect(() =>
    resolveEdges(new Set(), new Set(), [
      { target: auth, presence: "required" },
    ]),
  ).toThrow();
});
/**
 * @case contract dependencies allow replacement without impersonating a plugin id
 * @preconditions A consumer requires a port supplied by acme.postgres.
 * @expectedResult The provider orders first without copying the first-party ID; duplicates fail and token names do not alias.
 */
test("contract dependencies allow replacement without impersonating a plugin id", async () => {
  const { port, orderPlans } = await import("../src/typed/ports.ts");
  const store = port<{ open(): void }>("store@1");
  const replacement = { id: "acme.postgres", provides: [store], requires: [] };
  const consumer = { id: "deferral", provides: [], requires: [store] };
  expect(orderPlans([consumer, replacement]).map((p) => p.id)).toEqual([
    "acme.postgres",
    "deferral",
  ]);
  expect(() =>
    orderPlans([replacement, { ...replacement, id: "second" }]),
  ).toThrow("Ambiguous");
  expect(port<number>("same").key).not.toBe(port<string>("same").key);
});
/**
 * @case variadic pipe has no arity overload and checks heterogeneous adjacency
 * @preconditions Seven independently typed operators form a heterogeneous variadic pipeline.
 * @expectedResult The result is correctly typed and an incompatible operator has a checked compile error.
 */
test("variadic pipe has no arity overload and checks heterogeneous adjacency", async () => {
  const { variadicPipe } = await import("../src/typed/variadic-pipe.ts");
  const plus = (n: number) => n + 1,
    show = (n: number) => String(n),
    length = (s: string) => s.length;
  const result: number = variadicPipe(
    0,
    plus,
    plus,
    plus,
    plus,
    plus,
    show,
    length,
  );
  expect(result).toBe(1);
  function negative() {
    // @ts-expect-error a string operator cannot consume a number
    variadicPipe(0, length);
  }
  void negative;
});
