import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  DefaultExchange,
  MemoryDeferralStore,
  craft,
  direct,
  noop,
  deferAside,
} from "../src/index.ts";

/**
 * An aside deferral stores a continuation for a run that goes on. The run's
 * exchange keeps its frozen headers, so what the aside must leave behind
 * is the sequence a later deferral in the same run derives its id from.
 */

describe("deferAside", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A deferral after an aside deferral in the same run takes a fresh id
   * @preconditions A context with a memory deferral store; one exchange deferred aside twice, with ex.deferral.id read between the two
   * @expectedResult The second deferral's id differs from the first, both records exist in the store, and ex.deferral.id after the first deferral is the id the second deferral takes. With the sequence left on the record alone the second create collides with the first
   */
  test("advances the sequence the live exchange reads", async () => {
    const store = new MemoryDeferralStore();
    t = await testContext()
      .with({ deferral: { store } })
      .routes([craft().id("r").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();
    const exchange = new DefaultExchange(t.ctx, { body: { n: 1 } });
    const site = { position: 0, continuation: [] };
    const first = await deferAside(t.ctx, exchange, site, "r", (id) => ({
      id,
    }));
    const next = exchange.deferral.id;
    expect(next).not.toBe(first.deferralId);
    const second = await deferAside(t.ctx, exchange, site, "r", (id) => ({
      id,
    }));
    expect(second.deferralId).toBe(next);
    expect(await store.get(first.deferralId)).toBeDefined();
    expect(await store.get(second.deferralId)).toBeDefined();
  });

  /**
   * @case The caller learns the id before the record exists, and a failing announcement leaves no record
   * @preconditions A context with a memory deferral store; one deferral with an announce hook that records whether the store held the id when it ran; a second deferral whose announce hook throws
   * @expectedResult The first hook saw no record for the id and the deferral then exists under that id; the second deferral rejects with the hook's error and the store holds no record for it
   */
  test("announces the id before the record is written", async () => {
    const store = new MemoryDeferralStore();
    t = await testContext()
      .with({ deferral: { store } })
      .routes([craft().id("r").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();
    const exchange = new DefaultExchange(t.ctx, { body: { n: 1 } });
    const site = { position: 0, continuation: [] };
    let existedWhenAnnounced: boolean | undefined;
    let announced: string | undefined;
    const first = await deferAside(
      t.ctx,
      exchange,
      site,
      "r",
      (id) => ({ id }),
      async (id) => {
        announced = id;
        existedWhenAnnounced = (await store.get(id)) !== undefined;
      },
    );
    expect(announced).toBe(first.deferralId);
    expect(existedWhenAnnounced).toBe(false);
    expect(await store.get(first.deferralId)).toBeDefined();
    const before = MemoryDeferralStore.unsafeRecords(store).size;
    await expect(
      deferAside(
        t.ctx,
        exchange,
        site,
        "r",
        (id) => ({ id }),
        async () => {
          throw new Error("record write refused");
        },
      ),
    ).rejects.toThrow(/record write refused/);
    expect(MemoryDeferralStore.unsafeRecords(store).size).toBe(before);
  });
});
