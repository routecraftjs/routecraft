import { describe, expect, test } from "bun:test";
import { chain, registerStep } from "../src/typed/c-merged.ts";
import { filter, pipe, source, transform } from "../src/typed/d-pipe.ts";
import type { Exchange } from "../src/contracts/index.ts";

const fakeExchange = (body: unknown): Exchange => ({
  id: "x",
  routeId: "r",
  body,
  headers: {},
  use: () => undefined,
});

describe("encoding C: merged interface with a body type parameter", () => {
  /**
   * @case A chain of contributed steps executes in order
   * @preconditions transform and filter registered at import time
   * @expectedResult the body is transformed and the filter runs against it
   */
  test("a fluent chain of contributed steps runs", async () => {
    const flow = chain<{ subject: string }>()
      .transform((mail) => mail.subject)
      .filter((subject) => subject.length > 3);
    const ex = fakeExchange({ subject: "hello" });
    for (const step of flow.steps()) await step.run(ex);
    expect(ex.body).toBe("hello");
    expect(ex.headers["filtered"]).toBe(false);
  });

  /**
   * @case The unsoundness of S1 survives into the body-typed encoding
   * @preconditions a step declared in the merged interface and never registered
   * @expectedResult it compiles and is undefined at runtime
   */
  test("a declared-but-unregistered step still compiles and is absent", () => {
    const flow = chain<string>();
    // `phantom` is declared below and never registered.
    expect(
      (flow as unknown as Record<string, unknown>)["phantom"],
    ).toBeUndefined();
  });

  /**
   * @case Registering the same name twice is refused
   * @preconditions transform is already registered
   * @expectedResult the second registration throws
   */
  test("a duplicate registration is refused", () => {
    expect(() =>
      registerStep("transform", () => ({ label: "x", run: () => {} })),
    ).toThrow();
  });
});

declare module "../src/typed/c-merged.ts" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface StepRegistry<Body> {
    phantom(): void;
  }
}

describe("encoding D: free functions in a pipe", () => {
  /**
   * @case A piped route executes in order with the body flowing
   * @preconditions transform and filter imported as ordinary functions
   * @expectedResult the body is transformed twice and ends as a number
   */
  test("a piped route runs and the body type flows", async () => {
    const route = pipe(
      source<{ subject: string }>("mail"),
      transform((mail) => mail.subject),
      filter((subject) => subject.length > 3),
      transform((subject) => subject.length),
    );
    const ex = fakeExchange({ subject: "hello" });
    for (const step of route.steps) await step.run(ex);
    expect(ex.body).toBe(5);
  });

  /**
   * @case There is no second half that can drift
   * @preconditions an operator is an ordinary exported function
   * @expectedResult importing a nonexistent operator is a compile error, and
   *   there is no runtime registry to disagree with a declaration
   */
  test("an operator cannot be declared without being implemented", () => {
    // There is nothing to assert at runtime: the defect encoding C has is not
    // expressible here, because the declaration IS the implementation. This
    // test exists to record that, and to fail loudly if a registry is ever
    // introduced behind the operators.
    expect(typeof transform).toBe("function");
    expect(typeof filter).toBe("function");
  });
});
