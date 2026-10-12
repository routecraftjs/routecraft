import { afterEach, describe, expect, test } from "bun:test";
import { craft, direct, noop } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";

const route = (id: string) => craft().id(id).from(direct()).to(noop());

describe("testContext().routes", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Several routes passed as separate arguments to the test context are all registered
   * @preconditions Three builders in one routes() call and a list beside a builder in a second, as ContextBuilder accepts them
   * @expectedResult Every route is registered, so a test mirrors the production builder rather than silently dropping arguments past the first
   */
  test("registers every argument, as ContextBuilder does", async () => {
    t = await testContext()
      .routes(route("a"), route("b"), route("c"))
      .routes([route("d")], route("e"))
      .build();
    expect(t.ctx.getRoutes().map((r) => r.definition.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });
});
