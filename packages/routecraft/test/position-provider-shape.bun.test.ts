import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  definePlugin,
  direct,
  rcCodeOf,
  RESILIENCE,
  resilienceProvider,
  type ResiliencePositions,
  type RouteBuilder,
} from "../src/index.ts";

/** A replacement that provides retry alone. */
const partial = definePlugin({
  id: "test.partial",
  provides: [RESILIENCE],
  replaces: [RESILIENCE],
  bind(c) {
    c.provide(RESILIENCE, {
      retry: resilienceProvider.retry,
    } as unknown as ResiliencePositions);
  },
});

async function startFailure(t: TestContext): Promise<unknown> {
  try {
    await t.startAndWaitReady();
  } catch (error) {
    return error;
  }
  throw new Error("the start did not refuse");
}

describe("a position provider missing a member", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop().catch(() => undefined);
    t = undefined;
  });

  /**
   * @case A plugin replaces RESILIENCE with a provider that has retry only, and a route uses .timeout() at route scope, then at step scope
   * @preconditions The route compiles at start
   * @expectedResult RC1111 at start naming the route or step, the method, the port and the providing plugin, instead of a TypeError on the missing method
   */
  test("is RC1111 naming the plugin at both scopes", async () => {
    const routes: Record<string, RouteBuilder> = {
      route: craft()
        .id("work")
        .timeout("1s")
        .from(direct())
        .transform(() => "ok"),
      step: craft()
        .id("work")
        .from(direct())
        .timeout("1s")
        .transform(() => "ok"),
    };
    for (const [scope, route] of Object.entries(routes)) {
      t = await testContext()
        .with({ plugins: [partial] })
        .routes([route])
        .build();
      const error = await startFailure(t);
      const message = String(error);
      expect([scope, rcCodeOf(error)]).toEqual([scope, "RC1111"]);
      expect(message).toContain("test.partial");
      expect(message).toContain("timeout()");
      await t.stop().catch(() => undefined);
      t = undefined;
    }
  });
});
