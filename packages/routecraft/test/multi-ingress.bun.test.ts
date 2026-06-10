import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  craft,
  direct,
  isRoutecraftError,
  noop,
  simple,
} from "@routecraft/routecraft";
import { testContext, spy, type TestContext } from "@routecraft/testing";

function expectRC2001(thunk: () => unknown): void {
  let caught: unknown;
  try {
    thunk();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  expect(isRoutecraftError(caught)).toBe(true);
  expect((caught as { rc?: string }).rc).toBe("RC2001");
}

describe("Multi-ingress routes", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
    t = undefined;
  });

  /**
   * @case A route with several sources but no .input() is rejected at build time
   * @preconditions craft().from(simple(a), simple(b)) with no .input()
   * @expectedResult Building throws RC2001 because a shared pipeline needs a shared input contract
   */
  test("multi-source .from() without .input() throws RC2001", () => {
    expectRC2001(() =>
      craft()
        .id("multi-no-input")
        .from(simple({ id: "a" }), simple({ id: "b" }))
        .to(noop())
        .build(),
    );
  });

  /**
   * @case A zero-source .from() is rejected at the public boundary
   * @preconditions craft().from() called with no arguments (only reachable via untyped callers)
   * @expectedResult Throws RC2001; the runtime guard protects the published API from JS callers the overloads cannot constrain
   */
  test("zero-source .from() throws RC2001", () => {
    const builder = craft().id("empty") as unknown as {
      from: (...sources: unknown[]) => unknown;
    };
    expectRC2001(() => builder.from());
  });

  /**
   * @case Multi-ingress build produces a single route holding every source
   * @preconditions craft().input(schema).from(simple, direct, callable)
   * @expectedResult One RouteDefinition with all three sources under the same id
   */
  test("multi-source .from() with .input() builds one route with all sources", () => {
    const def = craft()
      .id("multi-ok")
      .input(z.object({ id: z.string() }))
      .from(simple({ id: "a" }), direct(), async (sub) => {
        await sub.emit({ message: { id: "c" } });
      })
      .to(noop())
      .build();

    expect(def).toHaveLength(1);
    expect(def[0].id).toBe("multi-ok");
    expect(def[0].sources).toHaveLength(3);
  });

  /**
   * @case A single source still builds with the original (non-variadic) behaviour
   * @preconditions craft().from(simple(x)) with no .input()
   * @expectedResult One route with exactly one source; no input requirement for the single-source case
   */
  test("single source keeps building without .input()", () => {
    const def = craft().id("single").from(simple("x")).to(noop()).build();

    expect(def).toHaveLength(1);
    expect(def[0].sources).toHaveLength(1);
  });

  /**
   * @case Two ingresses feed one shared pipeline and the route stays a single logical entity
   * @preconditions Route with .input() and two simple() ingresses producing {id:"a"} and {id:"b"}
   * @expectedResult Both validated bodies reach the destination and route:started fires exactly once
   */
  test("two ingresses feed one pipeline and route:started fires once", async () => {
    const s = spy();
    let startedCount = 0;

    t = await testContext()
      .routes(
        craft()
          .id("dual")
          .input(z.object({ id: z.string() }))
          .from(simple({ id: "a" }), simple({ id: "b" }))
          .to(s),
      )
      .build();

    t.ctx.on("route:started", () => {
      startedCount++;
    });

    await t.ctx.start();

    const ids = s.received
      .map((exchange) => (exchange.body as { id: string }).id)
      .sort();
    expect(ids).toEqual(["a", "b"]);
    expect(startedCount).toBe(1);
  });

  /**
   * @case Framework input validation normalizes each ingress to the schema output
   * @preconditions Route .input() strips unknown keys; both ingresses send an extra field
   * @expectedResult Every body delivered to the pipeline matches the validated shape regardless of ingress
   */
  test("input validation normalizes the body for every ingress", async () => {
    const s = spy();
    const schema = z.object({ id: z.string() }).strip();

    t = await testContext()
      .routes(
        craft()
          .id("normalize")
          .input(schema)
          .from(simple({ id: "a", extra: 1 }), simple({ id: "b", extra: 2 }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    for (const exchange of s.received) {
      expect(Object.keys(exchange.body as object).sort()).toEqual(["id"]);
    }
    expect(s.received).toHaveLength(2);
  });

  /**
   * @case Batch windows are per ingress, so a batch never merges items across channels
   * @preconditions Batch route (size 2) with two ingresses producing [1,2] and [3,4]
   * @expectedResult Two independent flushes (distinct batch ids), each carrying only its own ingress's pair
   */
  test("each ingress batches independently (no cross-ingress merge)", async () => {
    const s = spy();
    const flushed: { batchId: string; batchSize: number }[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("batched-dual")
          .batch({ size: 2 })
          .input(z.array(z.number()))
          .from(simple([1, 2]), simple([3, 4]))
          .to(s),
      )
      .build();

    t.ctx.on("route:batch:flushed", ({ details }) => {
      flushed.push({
        batchId: (details as { batchId: string }).batchId,
        batchSize: (details as { batchSize: number }).batchSize,
      });
    });

    await t.ctx.start();

    // Two independent windows, each flushing its own pair under a distinct id.
    expect(flushed).toHaveLength(2);
    expect(new Set(flushed.map((f) => f.batchId)).size).toBe(2);

    const delivered = s.received
      .map((exchange) =>
        [...(exchange.body as number[])].sort((a, b) => a - b).join(","),
      )
      .sort();
    expect(delivered).toEqual(["1,2", "3,4"]);
  });

  /**
   * @case A synchronous subscribe failure on one ingress aborts the whole route
   * @preconditions Multi-ingress route where a sibling source's subscribe() throws synchronously while start() is wiring sources
   * @expectedResult start() rejects and the route's controller is aborted, so already-subscribed sibling ingresses are torn down rather than leaked
   */
  test("synchronous subscribe failure aborts the route and tears down siblings", async () => {
    const boom = {
      subscribe: () => {
        throw new Error("subscribe boom");
      },
    };

    t = await testContext()
      .routes(
        craft()
          .id("sync-fail")
          .input(z.object({ id: z.string() }))
          .from(direct(), boom)
          .to(noop()),
      )
      .build();

    const route = t.ctx.getRouteById("sync-fail");
    expect(route).toBeDefined();

    let caught: unknown;
    try {
      await route!.start();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("subscribe boom");
    expect(route!.signal.aborted).toBe(true);
  });
});
