import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  MemoryDeferralStore,
  craft,
  direct,
  noop,
  recovery,
  type CraftConfig,
  type Deferred,
  type EventDetailsMap,
} from "../src/index.ts";
import { asDeferred } from "./helpers/deferral.ts";

const SECRET = "deferral-denied-event-test-secret-0123456789";

const Approval = z.object({ approved: z.boolean() });

type Denied = EventDetailsMap["route:exchange:denied"];

function shared(store: MemoryDeferralStore): CraftConfig {
  return { deferral: { store, secret: SECRET } };
}

/**
 * `route:exchange:denied`: a deferral settled as denied is announced once,
 * scoped to the deferred exchange, from each place core writes a denial.
 */
describe("route:exchange:denied", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A park whose notify hook fails is denied, and the denial is announced
   * @preconditions A route whose .error() parks with recovery.defer({ notify }) and whose notify throws, so the record is denied claim-first; a later replay of the token that was issued
   * @expectedResult The failing call reads RC5067; route:exchange:denied fires exactly once, carrying the deferral id, the deferred exchange's ids and the recorded reason; the replay reads RC5050 rather than resuming, and emits nothing more
   */
  test("a failed notify announces its denial once", async () => {
    const store = new MemoryDeferralStore();
    let issued: Deferred | undefined;
    const denied: Denied[] = [];
    const failed: string[] = [];

    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("work")
          .error(() =>
            recovery.defer({
              ttl: "1h",
              notify: (ack) => {
                issued = ack;
                throw new Error("the mail server said no");
              },
            }),
          )
          .from(direct())
          .transform(() => {
            throw new Error("needs a human");
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    t.ctx.on("route:exchange:denied", ({ details }) => {
      denied.push(details);
    });
    t.ctx.on("route:exchange:failed", ({ details }) => {
      failed.push(details.exchangeId);
    });
    await t.startAndWaitReady();

    await expect(t.client.sendDirect("work", {})).rejects.toMatchObject({
      rc: "RC5067",
    });
    await expect(
      t.client.sendDirect("answers", {
        token: issued!.token,
        result: { approved: true },
      }),
    ).rejects.toMatchObject({ rc: "RC5050" });

    const record = await store.get(issued!.deferralId);
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      routeId: "work",
      exchangeId: failed[0]!,
      deferralId: issued!.deferralId,
    });
    expect(denied[0]?.correlationId).toBeString();
    expect(denied[0]?.reason).toBeString();
    expect(record?.outcome?.reason).toBe(denied[0]?.reason);
  });

  /**
   * @case A resume refused because the route changed is denied, and the denial is announced
   * @preconditions The exchange defers in one context; a second context sharing the store runs the route with an edited step after the defer, and the token is presented to it twice
   * @expectedResult route:exchange:denied fires exactly once with reason "continuation changed" and the deferred exchange's own ids, though the first presentation reads RC5048 and the second RC5050
   */
  test("a changed continuation announces its denial once", async () => {
    const store = new MemoryDeferralStore();
    const deferredIds: Array<{ exchangeId: string; correlationId: string }> =
      [];

    const first = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .defer({ schema: Approval })
          .transform(() => ({ paid: 1 }))
          .to(noop()),
      ])
      .build();
    first.ctx.on("route:exchange:deferred", ({ details }) => {
      deferredIds.push({
        exchangeId: details.exchangeId,
        correlationId: details.correlationId,
      });
    });
    await first.startAndWaitReady();
    const deferred = asDeferred(await first.client.sendDirect("payout", {}));
    await first.stop();

    const denied: Denied[] = [];
    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("payout")
          .error(() => ({ reasked: true }))
          .from(direct())
          .defer({ schema: Approval })
          .transform(() => ({ paid: 2 }))
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    t.ctx.on("route:exchange:denied", ({ details }) => {
      denied.push(details);
    });
    await t.startAndWaitReady();

    const answer = () =>
      t!.client.sendDirect("answers", {
        token: deferred.token,
        result: { approved: true },
      });
    await expect(answer()).rejects.toMatchObject({ rc: "RC5048" });
    await expect(answer()).rejects.toMatchObject({ rc: "RC5050" });

    expect(denied).toEqual([
      {
        routeId: "payout",
        ...deferredIds[0]!,
        deferralId: deferred.deferralId,
        reason: "continuation changed",
      },
    ]);
  });
});
