import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  failedChildrenOf,
  rcError,
  recovery,
  simple,
} from "@routecraft/routecraft";

interface Failed {
  exchangeId: string;
  error: unknown;
  failedChildren?: readonly string[];
}

/**
 * A split child that fails with nothing handling it fails the aggregate that
 * joins it: a filtered child is a decision, a failed child is work that did
 * not happen.
 */
describe("a failed split child at the aggregate", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop();
    t = undefined;
  });

  function watch() {
    const failed: Failed[] = [];
    const completed: string[] = [];
    let parentId: string | undefined;
    const builder = testContext()
      .on("route:exchange:started", ({ details }) => {
        parentId ??= details.exchangeId;
      })
      .on("route:exchange:completed", ({ details }) => {
        completed.push(details.exchangeId);
      })
      .on("route:exchange:failed", ({ details }) => {
        failed.push(details);
      });
    return { builder, failed, completed, parent: () => parentId as string };
  }

  /**
   * @case One of three children throws and nothing handles it
   * @preconditions split, a transform that throws for the body 2, aggregate, then a tap
   * @expectedResult Both siblings still run; the aggregate and the tap do not; the parent fails with RC5001 whose cause is the child's error and whose event names the failed child
   */
  test("fails the parent instead of joining the survivors", async () => {
    const seen: number[] = [];
    const joined: unknown[] = [];
    const w = watch();
    t = await w.builder
      .routes(
        craft()
          .id("fan")
          .from(simple([[1, 2, 3]]))
          .split()
          .transform((n: unknown) => {
            if (n === 2) throw new Error("boom");
            seen.push(n as number);
            return n;
          })
          .aggregate()
          .tap((ex) => {
            joined.push(ex.body);
          }),
      )
      .build();

    await t.test();

    expect(seen).toEqual([1, 3]);
    expect(joined).toEqual([]);
    const parent = w.failed.find((f) => f.exchangeId === w.parent());
    expect(parent).toBeDefined();
    expect((parent!.error as { rc: string }).rc).toBe("RC5001");
    expect(
      ((parent!.error as { cause: { cause: Error } }).cause.cause as Error)
        .message,
    ).toBe("boom");
    const child = w.failed.find((f) => f.exchangeId !== w.parent());
    expect(parent!.failedChildren).toEqual([child!.exchangeId]);
    expect(w.completed).not.toContain(w.parent());
    // The two survivors completed as children; the join never produced a parent result.
    expect(w.completed).toHaveLength(2);
  });

  /**
   * @case Every child throws, so none reaches the aggregate
   * @preconditions split, a transform that always throws, aggregate
   * @expectedResult The parent fails and its event names both children
   */
  test("fails the parent when no child survives", async () => {
    const w = watch();
    t = await w.builder
      .routes(
        craft()
          .id("fan-all")
          .from(simple([[1, 2]]))
          .split()
          .transform(() => {
            throw new Error("boom");
          })
          .aggregate(),
      )
      .build();

    await t.test();

    const parent = w.failed.find((f) => f.exchangeId === w.parent());
    expect(parent?.failedChildren).toHaveLength(2);
    expect(w.completed).toEqual([]);
  });

  /**
   * @case A child dropped by a filter is still simply absent
   * @preconditions split, a filter that rejects the body 2, aggregate, then a tap
   * @expectedResult The aggregate joins the two survivors and the parent completes
   */
  test("leaves a filtered child out without failing", async () => {
    const joined: unknown[] = [];
    const w = watch();
    t = await w.builder
      .routes(
        craft()
          .id("fan-filter")
          .from(simple([[1, 2, 3]]))
          .split()
          .filter((ex) => (ex.body as unknown) !== 2)
          .aggregate()
          .tap((ex) => {
            joined.push(ex.body);
          }),
      )
      .build();

    await t.test();

    expect(joined).toEqual([[1, 3]]);
    expect(w.failed).toEqual([]);
    expect(w.completed).toContain(w.parent());
  });

  /**
   * @case A child whose failure the route's handler recovers counts as handled
   * @preconditions A route-scope .error() that recovers; one of three children throws; aggregate
   * @expectedResult The aggregate joins the two survivors and nothing fails
   */
  test("joins the survivors when the failure was handled", async () => {
    const joined: unknown[] = [];
    const w = watch();
    t = await w.builder
      .routes(
        craft()
          .id("fan-handled")
          .error(() => ({ recovered: true }))
          .from(simple([[1, 2, 3]]))
          .split()
          .transform((n: unknown) => {
            if (n === 2) throw new Error("boom");
            return n;
          })
          .aggregate()
          .tap((ex) => {
            joined.push(ex.body);
          }),
      )
      .build();

    await t.test();

    expect(joined).toEqual([[1, 3]]);
    expect(w.failed).toEqual([]);
  });

  /**
   * @case The route's handler is asked about the parent's failure
   * @preconditions A route-scope .error() that rethrows a child's failure and recovers the aggregate's, telling them apart with failedChildrenOf; one of two children throws
   * @expectedResult The handler sees the child's error and then the parent's, and its recovery of the parent completes the route
   */
  test("hands the parent's failure to the route's error handler", async () => {
    const handled: string[] = [];
    const w = watch();
    t = await w.builder
      .routes(
        craft()
          .id("fan-route-error")
          .error((error) => {
            const children = failedChildrenOf(error);
            handled.push(children ? "parent" : "child");
            return children ? { partial: true } : recovery.rethrow();
          })
          .from(simple([[1, 2]]))
          .split()
          .transform((n: unknown) => {
            if (n === 2) throw new Error("boom");
            return n;
          })
          .aggregate(),
      )
      .build();

    await t.test();

    expect(handled).toEqual(["child", "parent"]);
    expect(w.failed.map((f) => f.exchangeId)).not.toContain(w.parent());
  });

  /**
   * @case A failure inside a nested split climbs one join at a time
   * @preconditions Two outer children, each split again; one inner child throws; an inner and an outer aggregate
   * @expectedResult The inner aggregate fails its own parent, which is an outer child, and the outer aggregate then fails the route's exchange
   */
  test("propagates through a nested split", async () => {
    const outer: unknown[] = [];
    const w = watch();
    t = await w.builder
      .routes(
        craft()
          .id("fan-nested")
          .from(
            simple([
              [
                [1, 2],
                [3, 4],
              ],
            ]),
          )
          .split()
          .split()
          .transform((n: unknown) => {
            if (n === 4) throw new Error("boom");
            return n;
          })
          .aggregate()
          .aggregate()
          .tap((ex) => {
            outer.push(ex.body);
          }),
      )
      .build();

    await t.test();

    expect(outer).toEqual([]);
    const parent = w.failed.find((f) => f.exchangeId === w.parent());
    expect(parent).toBeDefined();
    // The inner child, the outer child it failed, and the route's exchange.
    expect(w.failed).toHaveLength(3);
    expect(parent!.failedChildren).toEqual([w.failed[1].exchangeId]);
  });

  /**
   * @case An outer child whose own split throws is joined at the outer aggregate, not the inner one
   * @preconditions Two outer children; the inner splitter throws for the second; an inner and an outer aggregate, then a tap
   * @expectedResult The first child's inner children are joined normally, the outer aggregate fails the route's exchange for the second child, and the tap never runs
   */
  test("joins a child that failed at its own split with its siblings", async () => {
    const outer: unknown[] = [];
    const w = watch();
    t = await w.builder
      .routes(
        craft()
          .id("fan-inner-split")
          .from(simple([[[1, 2], "bad"]]))
          .split()
          .split((ex) => {
            if (!Array.isArray(ex.body)) throw new Error("not a list");
            return ex.body as unknown as number[];
          })
          .aggregate()
          .aggregate()
          .tap((ex) => {
            outer.push(ex.body);
          }),
      )
      .build();

    await t.test();

    expect(outer).toEqual([]);
    const parent = w.failed.find((f) => f.exchangeId === w.parent());
    expect(parent?.failedChildren).toHaveLength(1);
    expect(w.failed).toHaveLength(2);
  });

  /**
   * @case The outer join waits for an inner join that is itself about to fail
   * @preconditions Two outer children; the first fails before the inner split, every inner child of the second fails; an inner and an outer aggregate
   * @expectedResult The route's exchange fails once and names both outer children; no exchange fails twice
   */
  test("names every failed child when an inner join fails late", async () => {
    const w = watch();
    t = await w.builder
      .routes(
        craft()
          .id("fan-late")
          .from(simple([[[1, 2], "bad"]]))
          .split()
          .process((ex) => {
            if (!Array.isArray(ex.body)) throw new Error("not a list");
            return ex;
          })
          .split()
          .transform(() => {
            throw new Error("boom");
          })
          .aggregate()
          .aggregate(),
      )
      .build();

    await t.test();

    const parent = w.failed.find((f) => f.exchangeId === w.parent());
    expect(parent?.failedChildren).toHaveLength(2);
    const ids = w.failed.map((f) => f.exchangeId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * @case The failed children stay on the event when the route's handler throws an error of its own
   * @preconditions A route-scope .error() that throws a new error for every failure; one of two children throws
   * @expectedResult The parent's route:exchange:failed carries the handler's error and still names the failed child
   */
  test("keeps the failed children when the handler throws its own error", async () => {
    const w = watch();
    t = await w.builder
      .routes(
        craft()
          .id("fan-handler-throws")
          .error(() => {
            throw new Error("handler gave up");
          })
          .from(simple([[1, 2]]))
          .split()
          .transform((n: unknown) => {
            if (n === 2) throw new Error("boom");
            return n;
          })
          .aggregate(),
      )
      .build();

    await t.test();

    const parent = w.failed.find((f) => f.exchangeId === w.parent());
    expect(parent?.failedChildren).toHaveLength(1);
  });

  /**
   * @case The parent's failure is retryable only when every failed child's is
   * @preconditions One child fails with a plain error, which is retryable, in one run; in another a child fails with a non-retryable RC5003
   * @expectedResult The parent's error is retryable in the first run and not in the second
   */
  test("takes its retryable flag from the failed children", async () => {
    const run = async (fail: () => never) => {
      const w = watch();
      t = await w.builder
        .routes(
          craft()
            .id("fan-retryable")
            .from(simple([[1, 2]]))
            .split()
            .transform((n: unknown) => (n === 2 ? fail() : n))
            .aggregate(),
        )
        .build();
      await t.test();
      await t.stop();
      const parent = w.failed.find((f) => f.exchangeId === w.parent());
      return (parent!.error as { retryable: boolean }).retryable;
    };

    expect(
      await run(() => {
        throw new Error("boom");
      }),
    ).toBe(true);
    expect(
      await run(() => {
        throw rcError("RC5003", undefined, { message: "misconfigured" });
      }),
    ).toBe(false);
  });
});
