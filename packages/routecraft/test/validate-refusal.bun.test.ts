import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import { callerRefusalOf, craft, direct, noop, refuse } from "../src/index.ts";

/**
 * A route that refuses its caller after the door: the rule needs state the
 * input schema cannot see (a page that already exists, a model's verdict),
 * so it runs as a `.validate()` step mid-pipeline, and the caller should be
 * told why, the way an `.input()` or a validate-hook refusal tells it.
 */
describe(".validate() refusing the caller", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop();
    t = undefined;
  });

  /**
   * @case A validator that throws a plain Error
   * @preconditions Route "capture" whose .validate() throws for a body it rejects
   * @expectedResult The failure is the instance's: callerRefusalOf answers undefined, so an unexpected throw never reaches a caller as a reason
   */
  test("leaves a plain throw the instance's", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("capture")
          .from(direct<{ title?: string }>())
          .validate((exchange) => {
            if (exchange.body.title === undefined) throw new Error("no title");
            return exchange.body;
          })
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();
    const error = await t.client.sendDirect("capture", {}).catch((e) => e);

    expect(
      callerRefusalOf(error, { routeId: "capture", principal: undefined }),
    ).toBeUndefined();
  });

  /**
   * @case A validator that refuses with refuse()
   * @preconditions Route "capture" whose .validate() answers refuse(reason, { kind: "conflict" }) for a body it rejects
   * @expectedResult The run fails, and callerRefusalOf classifies it for "capture" with the kind and the reason, exactly as a validate hook's refusal; undefined for any other route id, so a refusal raised inside a nested direct() call stays the instance's
   */
  test("tells the caller why when the validator refuses", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("capture")
          .from(direct<{ title?: string }>())
          .validate((exchange) =>
            exchange.body.title === "Weekly sync"
              ? refuse("A meeting page titled Weekly sync already exists.", {
                  kind: "conflict",
                })
              : exchange.body,
          )
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();
    const error = await t.client
      .sendDirect("capture", { title: "Weekly sync" })
      .then(() => undefined)
      .catch((e) => e);

    expect(error).toBeDefined();
    expect(
      callerRefusalOf(error, { routeId: "capture", principal: undefined }),
    ).toEqual({
      kind: "refused",
      as: "conflict",
      reason: "A meeting page titled Weekly sync already exists.",
    });
    expect(
      callerRefusalOf(error, { routeId: "outer", principal: undefined }),
    ).toBeUndefined();
  });
});
