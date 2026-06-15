import { afterEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, type Source } from "@routecraft/routecraft";

type Order = { id: string; amount: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
   * @preconditions Two paths each record the in-flight count on entry; a gate releases them once both have entered
   * @expectedResult The observed maximum in-flight count is 2, which is only reachable if both paths overlap
   */
  test("executes all paths concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let arrived = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const gated = () => ({
      send: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        arrived += 1;
        // Once both paths have entered, let them both finish.
        if (arrived === 2) releaseGate();
        // Bounded so a sequential regression cannot hang the test: the
        // maxInFlight assertion below (not this wait) is what proves overlap.
        // If the paths ran sequentially, the first would wait out the timeout
        // before the second ever entered, so maxInFlight would stay 1.
        await Promise.race([gate, sleep(500)]);
        inFlight -= 1;
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

    // Both paths were in flight at the same time: impossible if sequential.
    expect(maxInFlight).toBe(2);
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

  /**
   * @case A route-scope timeout aborts in-flight multicast paths
   * @preconditions Route with .timeout(30) wrapping a multicast whose slow path runs a step after an 80ms wait
   * @expectedResult The fast path completes, but the slow path's post-wait step never runs because the fired timeout's abortSignal reaches the path run
   */
  test("a route timeout aborts in-flight multicast paths", async () => {
    const fast = spy<Order>();
    const afterSlow = spy<Order>();

    t = await testContext()
      .routes(
        craft()
          .id("multicast-timeout-abort")
          // Route-scope timeout wraps the tail, including the multicast step.
          .timeout(30)
          .from(items<Order>([{ id: "a", amount: 1 }]))
          .multicast(
            (b) => b.to(fast), // completes immediately, before the deadline
            (b) =>
              b
                .process(async (ex) => {
                  // Still running when the 30ms deadline fires.
                  await sleep(80);
                  return ex;
                })
                .to(afterSlow), // the step AFTER the wait must be aborted
          ),
      )
      .build();

    await t.ctx.start();
    await t.drain();
    // Let the slow path's process() resolve so the nested run reaches the
    // post-wait step boundary, where the forwarded abortSignal stops it.
    await sleep(150);

    expect(fast.received).toHaveLength(1);
    // afterSlow is scheduled only after the 80ms process; by then the route
    // timeout (30ms) has aborted the path, so the post-wait .to() never runs.
    expect(afterSlow.received).toHaveLength(0);
  });

  /**
   * @case A zero-path multicast still emits a balanced started/stopped pair
   * @preconditions Route with .multicast() and no paths
   * @expectedResult started and stopped both fire, in order, with pathCount 0
   */
  test("a zero-path multicast emits a balanced started/stopped pair", async () => {
    const order: string[] = [];
    const counts: number[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("multicast-zero")
          .from(items<Order>([{ id: "a", amount: 1 }]))
          .multicast(),
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
    expect(counts).toEqual([0, 0]);
  });

  /**
   * @case A path-clone failure still emits a balanced started/stopped pair
   * @preconditions Body carries a function, so structuredClone throws while cloning the path
   * @expectedResult started and stopped both fire (try/finally), and the path never runs
   */
  test("a clone failure still emits a balanced started/stopped pair", async () => {
    const order: string[] = [];
    const sink = spy();

    // A function-valued body field is not structured-cloneable, so
    // cloneExchange throws DataCloneError while building the path runs.
    type WithFn = { run: () => void };

    t = await testContext()
      .routes(
        craft()
          .id("multicast-clone-throws")
          .from(items<WithFn>([{ run: () => undefined }]))
          .multicast((b) => b.to(sink)),
      )
      .on("route:operation:multicast:started", (() => {
        order.push("started");
      }) as never)
      .on("route:operation:multicast:stopped", (() => {
        order.push("stopped");
      }) as never)
      .build();

    await t.ctx.start();
    await t.drain();

    // Balanced despite the clone failure; the path itself never ran.
    expect(order).toEqual(["started", "stopped"]);
    expect(sink.received).toHaveLength(0);
  });
});
