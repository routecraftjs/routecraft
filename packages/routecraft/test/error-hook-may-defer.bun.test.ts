import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  definePlugin,
  direct,
  noop,
  rcCodeOf,
  recovery,
} from "../src/index.ts";

describe("an error hook that parks without declaring it", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case An error slot mutate hook answers recovery.defer() without mayDefer: true, in an application with a deferral runtime
   * @preconditions deferral configured; the route's step throws
   * @expectedResult The answer is refused as the hook breaking its contract (RC1115): the exchange is not parked, the hook is reported failed, and the caller gets the original failure
   */
  test("the park is refused and reported, never silent", async () => {
    const events: string[] = [];
    const failedHooks: string[] = [];
    const parker = definePlugin({
      id: "test.park",
      hooks: {
        error: {
          id: "park",
          phase: "mutate",
          run: () => recovery.defer({ ttl: "1h" }),
        },
      },
    });
    t = await testContext()
      .with({ plugins: [parker], deferral: {} })
      .routes([
        craft()
          .id("boom")
          .from(direct())
          .process(() => {
            throw new Error("fail");
          })
          .to(noop()),
      ])
      .build();
    t.ctx.on("route:exchange:deferred", () => {
      events.push("deferred");
    });
    t.ctx.on("route:exchange:failed", () => {
      events.push("failed");
    });
    t.ctx.on("route:error-handler:failed", ({ details }) => {
      failedHooks.push((details as { hook?: string }).hook ?? "");
    });
    await t.startAndWaitReady();

    let thrown: unknown;
    try {
      await t.client.sendDirect("boom", {});
    } catch (error) {
      thrown = error;
    }

    expect(rcCodeOf(thrown)).toBe("RC5001");
    expect(events).toEqual(["failed"]);
    expect(failedHooks).toEqual(["test.park/park"]);
  });
});
