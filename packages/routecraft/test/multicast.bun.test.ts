import { afterEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, type Source } from "@routecraft/routecraft";

type Order = { id: string; amount: number };

/**
 * Emits each item in `items` as its own exchange, strictly typed. Mirrors the
 * helper used by the choice suite.
 */
function items<T>(list: T[]): Source<T> {
  return {
    subscribe: async (sub) => {
      for (const item of list) {
        await sub.emit({ message: item });
      }
    },
  };
}

describe("multicast operation", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case multicast fans the exchange out to every path and the original continues
   * @preconditions Route with .multicast() over a bare destination and a sub-pipeline path, then a downstream .to()
   * @expectedResult Both paths receive the exchange and the downstream .to() runs on the original, unchanged
   */
  test("fans out to all paths, then the original continues downstream", async () => {
    const audit = spy<Order>();
    const warehouse = spy<{ id: string; amount: number; warehouse: true }>();
    const downstream = spy<Order>();

    t = await testContext()
      .routes(
        craft()
          .id("multicast-basic")
          .from(items<Order>([{ id: "a", amount: 10 }]))
          .multicast(audit, (b) => b
            .transform((body) => ({ ...body, warehouse: true as const }))
            .to(warehouse))
          .to(downstream),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(audit.received).toHaveLength(1);
    expect(audit.received[0].body).toEqual({ id: "a", amount: 10 });
    expect(warehouse.received).toHaveLength(1);
    expect(warehouse.received[0].body).toEqual({
      id: "a",
      amount: 10,
      warehouse: true,
    });
    // The original exchange continues unchanged after all paths settle.
    expect(downstream.received).toHaveLength(1);
    expect(downstream.received[0].body).toEqual({ id: "a", amount: 10 });
  });

  /**
   * @case Each path receives an independent deep copy of the exchange
   * @preconditions A path mutates its exchange body in place; a second path and the downstream read the same field
   * @expectedResult The mutation is confined to the mutating path's clone; the sibling path and the original are untouched
   */
  test("each path receives an independent deep copy", async () => {
    const sibling = spy<Order>();
    const downstream = spy<Order>();

    t = await testContext()
      .routes(
        craft()
          .id("multicast-deep-copy")
          .from(items<Order>([{ id: "a", amount: 10 }]))
          .multicast(
            // Mutate the clone's body in place; the deep copy must isolate it.
            (b) =>
              b.process((ex) => {
                ex.body.amount = 999;
                return ex;
              }),
            (b) => b.to(sibling),
          )
          .to(downstream),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(sibling.received[0].body.amount).toBe(10);
    expect(downstream.received[0].body.amount).toBe(10);
  });

  /**
   * @case All paths execute concurrently rather than sequentially
   * @preconditions Two paths each await a gate that only resolves once both have started
   * @expectedResult The gate resolves (both paths were in flight at once), proving parallel fan-out
   */
  test("executes all paths concurrently", async () => {
    let count = 0;
    let gateResolved = false;
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = () => {
        gateResolved = true;
        resolve();
      };
    });

    const gated = () => ({
      send: async () => {
        count += 1;
        if (count === 2) resolveGate();
        // If the paths ran sequentially, the first send would block here
        // forever (the second never starts); the timeout keeps the test
        // from hanging on a regression.
        await Promise.race([gate, new Promise((r) => setTimeout(r, 1000))]);
      },
    });

    t = await testContext()
      .routes(
        craft()
          .id("multicast-concurrent")
          .from(items<Order>([{ id: "a", amount: 1 }]))
          .multicast(gated(), gated()),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(gateResolved).toBe(true);
    expect(count).toBe(2);
  });

  /**
   * @case A failing path does not prevent sibling paths or the original from running
   * @preconditions One path's destination throws; a sibling path and the downstream .to() are also present
   * @expectedResult The sibling path and the downstream both run; the route is not failed by the bad path
   */
  test("a failing path does not stop the others (allSettled)", async () => {
    const sibling = spy<Order>();
    const downstream = spy<Order>();

    t = await testContext()
      .routes(
        craft()
          .id("multicast-error-isolation")
          .from(items<Order>([{ id: "a", amount: 1 }]))
          .multicast(
            {
              send: async () => {
                throw new Error("path blew up");
              },
            },
            (b) => b.to(sibling),
          )
          .to(downstream),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(sibling.received).toHaveLength(1);
    expect(downstream.received).toHaveLength(1);
    expect(downstream.received[0].body).toEqual({ id: "a", amount: 1 });
  });

  /**
   * @case halt() inside one path stops only that path
   * @preconditions One path sends then halts; a sibling path and the downstream are present
   * @expectedResult The halting path's sink still receives; the sibling and downstream run unaffected
   */
  test("halt() in one path does not affect the others", async () => {
    const halting = spy<Order>();
    const sibling = spy<Order>();
    const downstream = spy<Order>();

    t = await testContext()
      .routes(
        craft()
          .id("multicast-halt")
          .from(items<Order>([{ id: "a", amount: 1 }]))
          .multicast(
            (b) => b.to(halting).halt(),
            (b) => b.to(sibling),
          )
          .to(downstream),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(halting.received).toHaveLength(1);
    expect(sibling.received).toHaveLength(1);
    expect(downstream.received).toHaveLength(1);
  });

  /**
   * @case multicast emits started and stopped lifecycle events with the path count
   * @preconditions Route with a two-path multicast
   * @expectedResult started fires before stopped, both carrying pathCount: 2
   */
  test("emits multicast:started and multicast:stopped with pathCount", async () => {
    const sinkA = spy<Order>();
    const sinkB = spy<Order>();
    const order: string[] = [];
    const counts: number[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("multicast-events")
          .from(items<Order>([{ id: "a", amount: 1 }]))
          .multicast(sinkA, sinkB),
      )
      .on("route:operation:multicast:started", ((payload: {
        details: { pathCount: number };
      }) => {
        order.push("started");
        counts.push(payload.details.pathCount);
      }) as never)
      .on("route:operation:multicast:stopped", ((payload: {
        details: { pathCount: number };
      }) => {
        order.push("stopped");
        counts.push(payload.details.pathCount);
      }) as never)
      .build();

    await t.ctx.start();
    await t.drain();

    expect(order).toEqual(["started", "stopped"]);
    expect(counts).toEqual([2, 2]);
  });
});
