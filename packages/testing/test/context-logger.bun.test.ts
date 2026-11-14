import { afterEach, describe, expect, test } from "bun:test";
import { craft, noop, simple } from "@routecraft/routecraft";
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
   * @case Two test contexts alive at once each see only their own lines
   * @preconditions Two test contexts built concurrently, each with one route that logs its own marker
   * @expectedResult Each context's route spy holds its own marker and not the other's
   */
  test("keeps concurrent contexts' lines apart", async () => {
    const build = (marker: string) =>
      testContext()
        .routes(
          craft()
            .id(`concurrent-${marker}`)
            .from(simple("hello"))
            .log("info", marker)
            .to(noop()),
        )
        .build();
    const [first, second] = await Promise.all([
      build("first"),
      build("second"),
    ]);
    t = first;
    try {
      await Promise.all([first.test(), second.test()]);
    } finally {
      await second.stop();
    }

    const lines = (context: TestContext) =>
      context.logger.info.mock.calls.map((call) => call.at(-1));
    expect(lines(first)).toContain("first");
    expect(lines(first)).not.toContain("second");
    expect(lines(second)).toContain("second");
    expect(lines(second)).not.toContain("first");
  });
});
