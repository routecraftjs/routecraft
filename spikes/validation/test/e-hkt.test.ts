import { describe, expect, test } from "bun:test";
import { builder, deferral, operations } from "../src/e-hkt.ts";
import type { Exchange } from "../../plugin-architecture/src/contracts/index.ts";

const ex = (body: unknown): Exchange => ({
  id: "x",
  routeId: "r",
  body,
  headers: {},
  use: () => undefined,
});

describe("encoding E: fluent, body-typed, plugin-extensible AND sound", () => {
  /**
   * @case The chain the type system typed actually runs
   * @preconditions operations and deferral installed, four chained steps
   * @expectedResult the steps run in order and produce the typed result
   */
  test("the runtime agrees with the types", async () => {
    const b = builder<
      readonly [typeof operations, typeof deferral],
      { subject: string }
    >([operations, deferral]);
    const steps = b
      .transform((mail) => mail.subject)
      .filter((subject) => subject.length > 0)
      .transform((subject) => subject.length)
      .defer("needs approval")
      .build();
    expect(steps.map((s) => s.label)).toEqual([
      "transform",
      "filter",
      "transform",
      "defer",
    ]);
    const e = ex({ subject: "hello" });
    for (const step of steps) await step.run(e);
    expect(e.body).toBe(5);
    expect(e.headers["deferred"]).toBe("needs approval");
  });

  /**
   * @case A declined plugin's step is absent at runtime as well as in the type
   * @preconditions only operations installed
   * @expectedResult the property is undefined
   */
  test("a declined plugin's step is absent at runtime too", () => {
    const b = builder<readonly [typeof operations], string>([operations]);
    expect((b as unknown as Record<string, unknown>)["defer"]).toBeUndefined();
  });

  /**
   * @case Two plugins contributing the same step name
   * @preconditions both declare `transform`
   * @expectedResult construction throws, because a name cannot be shared
   */
  test("a step-name collision is refused at construction", () => {
    expect(() =>
      builder([operations, { id: "clash", steps: operations.steps }]),
    ).toThrow(/transform/);
  });
});
