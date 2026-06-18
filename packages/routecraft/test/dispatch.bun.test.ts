import { afterEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, weighted, type Source } from "@routecraft/routecraft";

type Job = { id: string; userId: string };

/**
 * Emits each item in `list` as its own exchange, strictly typed. Mirrors the
 * helper used by the multicast / choice suites.
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

const job = (id: string, userId = "u"): Job => ({ id, userId });

describe("dispatch operation", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case round-robin cycles targets in order and the original continues
   * @preconditions Three exchanges through .dispatch("round-robin", a, b, c) then a downstream .to()
   * @expectedResult The three exchanges land on a, b, c respectively; the downstream sees all three unchanged
   */
  test("round-robin cycles through targets in order", async () => {
    const a = spy<Job>();
    const b = spy<Job>();
    const c = spy<Job>();
    const downstream = spy<Job>();

    t = await testContext()
      .routes(
        craft()
          .id("dispatch-round-robin")
          .from(items<Job>([job("1"), job("2"), job("3")]))
          .dispatch("round-robin", a, b, c)
          .to(downstream),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(a.received.map((e) => e.body.id)).toEqual(["1"]);
    expect(b.received.map((e) => e.body.id)).toEqual(["2"]);
    expect(c.received.map((e) => e.body.id)).toEqual(["3"]);
    // Side-effect-only: every original continues downstream unchanged.
    expect(downstream.received.map((e) => e.body.id)).toEqual(["1", "2", "3"]);
  });

  /**
   * @case The selected target runs on an isolated clone; the original is untouched
   * @preconditions A target mutates its clone's body in place; a downstream .to() reads the same field
   * @expectedResult The mutation stays on the clone; the original continues unchanged
   */
  test("the selected target runs on an isolated deep copy", async () => {
    const downstream = spy<Job>();

    t = await testContext()
      .routes(
        craft()
          .id("dispatch-deep-copy")
          .from(items<Job>([job("1")]))
          .dispatch("round-robin", (b) => b.process((ex) => {
            ex.body.id = "mutated";
            return ex;
          }))
          .to(downstream),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(downstream.received[0].body.id).toBe("1");
  });

  /**
   * @case weighted distributes by relative weight (smooth weighted round-robin)
   * @preconditions 100 exchanges through .dispatch("weighted", weighted(stable, 95), weighted(canary, 5))
   * @expectedResult stable receives 95 and canary receives 5, deterministically
   */
  test("weighted distributes by relative weight", async () => {
    const stable = spy<Job>();
    const canary = spy<Job>();

    const jobs = Array.from({ length: 100 }, (_, i) => job(String(i)));

    t = await testContext()
      .routes(
        craft()
          .id("dispatch-weighted")
          .from(items<Job>(jobs))
          .dispatch("weighted", weighted(stable, 95), weighted(canary, 5)),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(stable.received).toHaveLength(95);
    expect(canary.received).toHaveLength(5);
  });

  /**
   * @case failover tries the next target only when the preferred one fails
   * @preconditions primary throws; secondary succeeds; one exchange dispatched
   * @expectedResult secondary receives the exchange; the original continues; selected fires for both attempts
   */
  test("failover advances to the next target on failure", async () => {
    const secondary = spy<Job>();
    const downstream = spy<Job>();
    const selected: number[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("dispatch-failover")
          .from(items<Job>([job("1")]))
          .dispatch(
            "failover",
            {
              send: async () => {
                throw new Error("primary down");
              },
            },
            secondary,
          )
          .to(downstream),
      )
      .on("route:operation:dispatch:selected", ((payload: {
        details: { targetIndex: number };
      }) => {
        selected.push(payload.details.targetIndex);
      }) as never)
      .build();

    await t.ctx.start();
    await t.drain();

    expect(secondary.received).toHaveLength(1);
    expect(downstream.received).toHaveLength(1);
    // Tried target 0 (failed), then target 1 (succeeded).
    expect(selected).toEqual([0, 1]);
  });

  /**
   * @case failover sticks to the promoted target on subsequent exchanges
   * @preconditions primary always throws; two exchanges dispatched via failover
   * @expectedResult After the first failover the cursor promotes to secondary; the second exchange goes straight to secondary (primary tried once total)
   */
  test("failover promotes the healthy target (cursor persists)", async () => {
    let primaryHits = 0;
    const secondary = spy<Job>();

    t = await testContext()
      .routes(
        craft()
          .id("dispatch-failover-cursor")
          .from(items<Job>([job("1"), job("2")]))
          .dispatch(
            "failover",
            {
              send: async () => {
                primaryHits += 1;
                throw new Error("primary down");
              },
            },
            secondary,
          ),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    // Primary is probed once (first exchange); the cursor then promotes to
    // secondary, so the second exchange never re-probes the dead primary.
    expect(primaryHits).toBe(1);
    expect(secondary.received).toHaveLength(2);
  });

  /**
   * @case failover that exhausts every target emits the exhausted event and still continues
   * @preconditions Both targets throw; one exchange dispatched; a downstream .to() follows
   * @expectedResult dispatch:exhausted fires with targetCount 2; the original still continues downstream
   */
  test("failover emits exhausted when every target fails", async () => {
    const downstream = spy<Job>();
    let exhaustedCount: number | undefined;

    const failing = () => ({
      send: async () => {
        throw new Error("down");
      },
    });

    t = await testContext()
      .routes(
        craft()
          .id("dispatch-exhausted")
          .from(items<Job>([job("1")]))
          .dispatch("failover", failing(), failing())
          .to(downstream),
      )
      .on("route:operation:dispatch:exhausted", ((payload: {
        details: { targetCount: number };
      }) => {
        exhaustedCount = payload.details.targetCount;
      }) as never)
      .build();

    await t.ctx.start();
    await t.drain();

    expect(exhaustedCount).toBe(2);
    // Side-effect-only: the original continues even when no target handled it.
    expect(downstream.received).toHaveLength(1);
  });

  /**
   * @case sticky routes exchanges sharing a key to the same target
   * @preconditions Keyed by userId; jobs for users u1 (x2) and u2 (x1); two targets
   * @expectedResult Both u1 jobs land on one target and u2's on the other (new keys round-robin across targets)
   */
  test("sticky keeps a key on one target", async () => {
    const a = spy<Job>();
    const b = spy<Job>();

    t = await testContext()
      .routes(
        craft()
          .id("dispatch-sticky")
          .from(items<Job>([job("1", "u1"), job("2", "u2"), job("3", "u1")]))
          .dispatch({ strategy: "sticky", key: (ex) => ex.body.userId }, a, b),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    // First new key (u1) -> target a; second new key (u2) -> target b; the
    // repeat of u1 sticks to a.
    expect(a.received.map((e) => e.body.id)).toEqual(["1", "3"]);
    expect(b.received.map((e) => e.body.id)).toEqual(["2"]);
  });

  /**
   * @case A non-failover target failure stays isolated and does not fail the route
   * @preconditions round-robin over a single throwing target; a downstream .to() follows
   * @expectedResult The downstream still runs on the original; the route is not failed by the bad target
   */
  test("a failing target stays isolated (non-failover)", async () => {
    const downstream = spy<Job>();

    t = await testContext()
      .routes(
        craft()
          .id("dispatch-isolation")
          .from(items<Job>([job("1")]))
          .dispatch("round-robin", {
            send: async () => {
              throw new Error("boom");
            },
          })
          .to(downstream),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(downstream.received).toHaveLength(1);
    expect(downstream.received[0].body.id).toBe("1");
  });

  /**
   * @case dispatch emits a selected event carrying the strategy and target index
   * @preconditions Single exchange through round-robin over two targets
   * @expectedResult One selected event fires with strategy "round-robin" and targetIndex 0
   */
  test("emits dispatch:selected with strategy and targetIndex", async () => {
    const a = spy<Job>();
    const b = spy<Job>();
    const events: Array<{ strategy: string; targetIndex: number }> = [];

    t = await testContext()
      .routes(
        craft()
          .id("dispatch-selected-event")
          .from(items<Job>([job("1")]))
          .dispatch("round-robin", a, b),
      )
      .on("route:operation:dispatch:selected", ((payload: {
        details: { strategy: string; targetIndex: number };
      }) => {
        events.push({
          strategy: payload.details.strategy,
          targetIndex: payload.details.targetIndex,
        });
      }) as never)
      .build();

    await t.ctx.start();
    await t.drain();

    expect(events).toEqual([{ strategy: "round-robin", targetIndex: 0 }]);
  });

  /**
   * @case dispatch with no targets is rejected at build time
   * @preconditions A route built with .dispatch("round-robin") and no targets
   * @expectedResult Building throws (RC5003): a dispatch with nothing to select is meaningless
   */
  test("rejects an empty target list at build time", () => {
    expect(() =>
      craft()
        .id("dispatch-empty")
        .from(items<Job>([job("1")]))
        .dispatch("round-robin")
        .build(),
    ).toThrow();
  });

  /**
   * @case weighted() rejects a non-positive weight at build time
   * @preconditions weighted(target, 0)
   * @expectedResult The helper throws (RC5003) so a starved target fails fast
   */
  test("weighted() rejects a non-positive weight", () => {
    const sink = spy<Job>();
    expect(() => weighted(sink, 0)).toThrow();
  });

  /**
   * @case sticky requires a key (no string form)
   * @preconditions .dispatch("sticky" as never, a, b) built without a key selector
   * @expectedResult Building throws (RC5003) pointing at the object form
   */
  test("sticky without a key is rejected at build time", () => {
    const a = spy<Job>();
    const b = spy<Job>();
    expect(() =>
      craft()
        .id("dispatch-sticky-no-key")
        .from(items<Job>([job("1")]))
        // Force the invalid string form a JS caller might pass.
        .dispatch("sticky" as never, a, b)
        .build(),
    ).toThrow();
  });
});
