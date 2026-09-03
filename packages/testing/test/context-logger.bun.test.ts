import { afterEach, describe, expect, test } from "bun:test";
import { craft, logger, noop, simple } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";

describe("context logger spy", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Context-level and route-level logger calls are recorded by separate spies
   * @preconditions A test context is built with one route; each logger receives a distinct marker
   * @expectedResult t.contextLogger captures ctx.logger calls while t.logger captures route logger calls without cross-contamination
   */
  test("separates context and route logger calls", async () => {
    t = await testContext()
      .routes(craft().id("context-logger").from(simple("hello")).to(noop()))
      .build();

    expect(t.ctx.logger as unknown).toBe(t.contextLogger);
    expect(t.contextLogger).not.toBe(t.logger);
    expect(t.ctx.logger.warn).toBe(t.contextLogger.warn);
    expect(t.ctx.logger.warn).not.toBe(t.logger.warn);

    t.ctx.logger.warn({ source: "context" }, "context-level");
    t.ctx.getRoutes()[0]?.logger.info({ source: "route" }, "route-level");

    expect(t.contextLogger.warn.mock.calls).toContainEqual([
      { source: "context" },
      "context-level",
    ]);
    expect(t.logger.info.mock.calls).toContainEqual([
      { source: "route" },
      "route-level",
    ]);
    expect(t.contextLogger.info.mock.calls).not.toContainEqual([
      { source: "route" },
      "route-level",
    ]);
  });

  /**
   * @case Stopping a context restores the global logger child implementation
   * @preconditions A test context has installed its context and route logger spies
   * @expectedResult logger.child returns a framework logger rather than a test spy after teardown
   */
  test("restores logger.child after teardown", async () => {
    const originalChild = logger.child;
    t = await testContext()
      .routes(
        craft().id("context-logger-restore").from(simple("hello")).to(noop()),
      )
      .build();

    await t.stop();

    expect(logger.child).toBe(originalChild);
  });
});
