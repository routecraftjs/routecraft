import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  DefaultExchange,
  MemorySuspensionStore,
  craft,
  direct,
  noop,
  parkAside,
} from "../src/index.ts";

/**
 * An aside park stores a continuation for a run that goes on. The run's
 * exchange keeps its frozen headers, so what the aside must leave behind
 * is the sequence a later park in the same run derives its id from.
 */

describe("parkAside", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A park after an aside park in the same run takes a fresh id
   * @preconditions A context with a memory suspension store; one exchange parked aside twice, with ex.suspension.id read between the two
   * @expectedResult The second park's id differs from the first, both records exist in the store, and ex.suspension.id after the first park is the id the second park takes. With the sequence left on the record alone the second create collides with the first
   */
  test("advances the sequence the live exchange reads", async () => {
    const store = new MemorySuspensionStore();
    t = await testContext()
      .with({ suspension: { store } })
      .routes([craft().id("r").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();
    const exchange = new DefaultExchange(t.ctx, { body: { n: 1 } });
    const site = { position: 0, continuation: [] };
    const first = await parkAside(t.ctx, exchange, site, "r", (id) => ({
      id,
    }));
    const next = exchange.suspension.id;
    expect(next).not.toBe(first.suspensionId);
    const second = await parkAside(t.ctx, exchange, site, "r", (id) => ({
      id,
    }));
    expect(second.suspensionId).toBe(next);
    expect(await store.get(first.suspensionId)).toBeDefined();
    expect(await store.get(second.suspensionId)).toBeDefined();
  });

  /**
   * @case The caller learns the id before the record exists, and a failing announcement leaves no record
   * @preconditions A context with a memory suspension store; one park with an announce hook that records whether the store held the id when it ran; a second park whose announce hook throws
   * @expectedResult The first hook saw no record for the id and the park then exists under that id; the second park rejects with the hook's error and the store holds no record for it
   */
  test("announces the id before the record is written", async () => {
    const store = new MemorySuspensionStore();
    t = await testContext()
      .with({ suspension: { store } })
      .routes([craft().id("r").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();
    const exchange = new DefaultExchange(t.ctx, { body: { n: 1 } });
    const site = { position: 0, continuation: [] };
    let existedWhenAnnounced: boolean | undefined;
    let announced: string | undefined;
    const first = await parkAside(
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
    expect(announced).toBe(first.suspensionId);
    expect(existedWhenAnnounced).toBe(false);
    expect(await store.get(first.suspensionId)).toBeDefined();
    const before = MemorySuspensionStore.unsafeRecords(store).size;
    await expect(
      parkAside(
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
    expect(MemorySuspensionStore.unsafeRecords(store).size).toBe(before);
  });
});
