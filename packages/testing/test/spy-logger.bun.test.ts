import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  createSpyFn,
  fixtureEach,
  testContext,
  type TestContext,
} from "@routecraft/testing";
import { craft, simple, noop, logger } from "@routecraft/routecraft";

describe("createSpyFn", () => {
  /**
   * @case Records every call's arguments in mock.calls
   * @preconditions Built-in spy created with createSpyFn(); called twice with different args
   * @expectedResult mock.calls holds both argument lists in call order
   */
  test("records calls in the jest-compatible mock.calls shape", () => {
    const fn = createSpyFn();
    fn("a", 1);
    fn({ b: 2 });
    expect(fn.mock.calls).toEqual([["a", 1], [{ b: 2 }]]);
  });

  /**
   * @case mockImplementation drives the return value
   * @preconditions Spy with a mockImplementation returning a constant
   * @expectedResult Calls return the implementation's value and are still recorded
   */
  test("mockImplementation sets behaviour and keeps recording", () => {
    const fn = createSpyFn();
    fn.mockImplementation(() => "out");
    expect(fn("in")).toBe("out");
    expect(fn.mock.calls).toEqual([["in"]]);
  });

  /**
   * @case mockClear empties recorded calls
   * @preconditions Spy called once, then cleared
   * @expectedResult mock.calls is empty after mockClear
   */
  test("mockClear resets recorded calls", () => {
    const fn = createSpyFn();
    fn("x");
    fn.mockClear();
    expect(fn.mock.calls).toEqual([]);
  });
});

describe("spy logger runner-agnostic default", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Default testContext() spy logger records log calls without any runner mock library
   * @preconditions testContext() built with no fn option; route logs via the framework logger
   * @expectedResult t.logger.info.mock.calls captures the log call so assertions work under bun test without Vitest installed
   */
  test("default spy logger records calls via mock.calls", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("spy-logger-default")
          .from(simple("hello"))
          .tap((ex) => ex.logger.info("tapped"))
          .to(noop()),
      )
      .build();
    await t.test();

    const messages = t.logger.info.mock.calls.map((c) => c[0]);
    expect(messages).toContain("tapped");
  });

  /**
   * @case A rejected build restores the patched logger.child instead of leaking it
   * @preconditions testContext() with an invalid route (no .from()) so builder.build() rejects
   * @expectedResult build() rethrows and logger.child is the original framework implementation afterwards
   */
  test("restores logger.child when build rejects", async () => {
    const original = logger.child;
    let threw = false;
    try {
      await testContext().routes(craft().id("invalid-no-source")).build();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(logger.child).toBe(original);
  });

  /**
   * @case An injected runner mock factory yields native bun mocks on the spy logger
   * @preconditions testContext({ fn: mock }) with mock from bun:test; route logs via the framework logger
   * @expectedResult expect(t.logger.info).toHaveBeenCalled() passes because the logger methods are real bun mocks
   */
  test("injected bun mock factory enables native matchers", async () => {
    t = await testContext({ fn: mock })
      .routes(
        craft()
          .id("spy-logger-injected")
          .from(simple("hello"))
          .tap((ex) => ex.logger.info("tapped"))
          .to(noop()),
      )
      .build();
    await t.test();

    expect(t.logger.info).toHaveBeenCalled();
  });
});

describe("fixtureEach", () => {
  /**
   * @case fixtureEach registers one test per fixture entry via the passed runner test fn
   * @preconditions JSON array fixture with two named entries; bun:test's test passed as the runner
   * @expectedResult Both entries are registered and executed as individual tests with their names
   */
  const seen: string[] = [];
  fixtureEach<{ name: string; value: number }>(
    new URL("./fixtures/spy-logger-cases.json", import.meta.url).pathname,
    test,
    (entry) => {
      seen.push(entry.name);
      expect(entry.value).toBeGreaterThan(0);
    },
  );

  /**
   * @case Entries run in fixture order before this trailing assertion
   * @preconditions The two fixtureEach tests above have executed
   * @expectedResult seen contains both fixture names in file order
   */
  test("ran every fixture entry", () => {
    expect(seen).toEqual(["first case", "second case"]);
  });
});
