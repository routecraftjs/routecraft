import { describe, expect, test } from "bun:test";
import {
  derivedBuilder,
  FluentBuilder,
  typedDeferral,
  typedOperations,
} from "../src/builder/index.ts";

describe("candidate B: declaration merging, which registerDsl uses today", () => {
  /**
   * @case A registered method works through the merged declaration
   * @preconditions registerFluent("upper") ran at import time
   * @expectedResult the method exists, is typed, and transforms the body
   */
  test("a registered method is typed and runs", async () => {
    const builder = new FluentBuilder<{ body: string }>();
    builder.upper();
    const ex = {
      body: "hi",
      headers: {},
      id: "x",
      routeId: "r",
      use: () => undefined,
    };
    await builder.steps[0]!.run(ex);
    expect(ex.body).toBe("HI");
  });

  /**
   * @case The two halves of registerDsl can disagree with nothing to catch it
   * @preconditions a method is declared in the type half and never registered
   * @expectedResult it typechecks and throws at runtime, which is the gap
   */
  test("a declared-but-unregistered method typechecks and fails at runtime", () => {
    const builder = new FluentBuilder<{ body: string }>();
    // `ghost` is declared below and deliberately never registered. If the
    // type half and the runtime half were one thing, this line would not
    // compile. It does compile, which is the finding.
    expect(() => builder.ghost()).toThrow(TypeError);
  });
});

declare module "../src/builder/index.ts" {
  // The type parameter list must match the declaration exactly for the merge
  // to apply, so `S` is unavoidably unused here. That obligation is itself
  // part of what makes candidate B fragile; see README F3.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface FluentBuilder<S extends { body: unknown }> {
    ghost(): this;
  }
}

describe("candidate C: builder derived from the installed plugin set", () => {
  /**
   * @case Methods come from the plugins actually passed in
   * @preconditions operations and deferral declare their steps in their types
   * @expectedResult both methods exist, are typed, and chain
   */
  test("the builder has exactly the installed plugins' steps", () => {
    const b = derivedBuilder([typedOperations, typedDeferral]);
    const steps = b
      .transform((body) => String(body).toUpperCase())
      .defer("needs approval")
      .build();
    expect(steps.map((s) => s.label)).toEqual(["transform", "defer"]);
  });

  /**
   * @case Declining a plugin removes its method from the builder's type
   * @preconditions only operations is installed
   * @expectedResult `defer` is absent at runtime, and `@ts-expect-error` proves
   *   it is absent at the type level too
   */
  test("a declined plugin's step is absent from the type, not just at runtime", () => {
    const b = derivedBuilder([typedOperations]);
    // @ts-expect-error `defer` comes from the deferral plugin, which is not installed.
    expect(b.defer).toBeUndefined();
  });
});
