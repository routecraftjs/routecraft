import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  simple,
  type Exchange,
  type SendContext,
} from "@routecraft/routecraft";

/**
 * The adapter observability hooks, one per role slot. A step reads the hook
 * that matches the slot it resolved, so an adapter whose hook is named for
 * the other slot goes silent without any type error: `getMetadata` on a
 * send-only Destination is never called, and neither is `getSendMetadata` on
 * a fetch-only Enricher.
 */
describe("adapter metadata hooks", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /** Collect the metadata attached to a named operation's completion event. */
  const metadataFor = (
    events: Array<{ event: string; details: Record<string, unknown> }>,
    operation: string,
  ): Record<string, unknown> | undefined => {
    const completed = events.find(
      (e) =>
        e.event === "route:step:completed" &&
        e.details["operation"] === operation,
    );
    return completed?.details["metadata"] as
      Record<string, unknown> | undefined;
  };

  /**
   * @case A send-resolved .to() reads getSendMetadata with the receipt record
   * @preconditions Destination sets a receipt header and implements getSendMetadata
   * @expectedResult The step:completed event carries metadata derived from the receipts
   */
  test("send-resolved .to() reads getSendMetadata", async () => {
    const events: Array<{ event: string; details: Record<string, unknown> }> =
      [];

    t = await testContext()
      .routes(
        craft()
          .id("meta-send")
          .from(simple({ id: 1 }))
          .to({
            adapterId: "test.sender",
            send: (_exchange: Exchange<unknown>, ctx?: SendContext) => {
              ctx?.setHeader("test.receipt", "abc");
            },
            getSendMetadata: (receipts?: Record<string, unknown>) => ({
              receipt: receipts?.["test.receipt"],
            }),
          }),
      )
      .build();

    t.ctx.on("route:step:completed", (e) => {
      events.push({
        event: "route:step:completed",
        details: e.details as Record<string, unknown>,
      });
    });
    await t.test();

    expect(metadataFor(events, "to")?.["receipt"]).toBe("abc");
  });

  /**
   * @case A fetch-resolved step reads getMetadata with the fetched value
   * @preconditions Enricher implements getMetadata; used via .enrich()
   * @expectedResult The step:completed event carries metadata derived from the result
   */
  test("fetch-resolved .enrich() reads getMetadata", async () => {
    const events: Array<{ event: string; details: Record<string, unknown> }> =
      [];

    t = await testContext()
      .routes(
        craft()
          .id("meta-fetch")
          .from(simple({ id: 1 }))
          .enrich({
            adapterId: "test.fetcher",
            fetch: () => ({ rows: [1, 2, 3] }),
            getMetadata: (result: unknown) => ({
              count: (result as { rows: number[] }).rows.length,
            }),
          }),
      )
      .build();

    t.ctx.on("route:step:completed", (e) => {
      events.push({
        event: "route:step:completed",
        details: e.details as Record<string, unknown>,
      });
    });
    await t.test();

    expect(metadataFor(events, "enrich")?.["count"]).toBe(3);
  });

  /**
   * @case Both hooks receive the exchange the call ran against
   * @preconditions Adapter derives its metadata from the exchange, not from instance state
   * @expectedResult Each exchange's event reports its own value, with several in flight
   */
  test("hooks derive per-exchange metadata from the exchange argument", async () => {
    const events: Array<{ event: string; details: Record<string, unknown> }> =
      [];

    // One adapter object serves every exchange, mirroring a real route: a
    // hook that remembered the last call on `this` would report whichever
    // exchange resolved last for all of them.
    const enricher = {
      adapterId: "test.per-exchange",
      fetch: async (exchange: Exchange<{ id: number }>) => {
        // Yield so the exchanges genuinely interleave.
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { seen: exchange.body.id };
      },
      getMetadata: (_result: unknown, exchange?: Exchange<unknown>) => ({
        id: (exchange?.body as { id: number } | undefined)?.id,
      }),
    };

    t = await testContext()
      .routes(
        craft()
          .id("meta-concurrent")
          .from(simple([{ id: 1 }, { id: 2 }, { id: 3 }]))
          .split()
          .enrich(enricher),
      )
      .build();

    t.ctx.on("route:step:completed", (e) => {
      events.push({
        event: "route:step:completed",
        details: e.details as Record<string, unknown>,
      });
    });
    await t.test();

    const enrichEvents = events.filter(
      (e) => e.details["operation"] === "enrich",
    );
    expect(enrichEvents).toHaveLength(3);
    const reported = enrichEvents
      .map(
        (e) =>
          (e.details["metadata"] as Record<string, unknown> | undefined)?.[
            "id"
          ],
      )
      .sort();
    expect(reported).toEqual([1, 2, 3]);
  });
});
