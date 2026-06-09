import { afterEach, describe, expect, mock, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, simple } from "@routecraft/routecraft";

describe("Async Tap Execution", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case Verify tap runs asynchronously (fire-and-forget)
   * @preconditions Route with tap operation
   * @expectedResult Route completes without waiting for tap
   */
  test("tap executes asynchronously", async () => {
    const tapCompleted = mock();
    const routeCompleted = mock();
    let tapExecutionTime = 0;
    let routeExecutionTime = 0;

    const startTime = Date.now();

    t = await testContext()
      .routes(
        craft()
          .id("test-async-tap")
          .from(simple({ data: "test" }))
          .tap(async () => {
            // Simulate slow tap operation
            await new Promise((resolve) => setTimeout(resolve, 20));
            tapExecutionTime = Date.now() - startTime;
            tapCompleted();
          })
          .to(() => {
            routeExecutionTime = Date.now() - startTime;
            routeCompleted();
          }),
      )
      .build();

    await t.ctx.start();

    // Route should complete before tap (tap delays 20ms; allow headroom for CI)
    expect(routeCompleted).toHaveBeenCalledTimes(1);
    expect(routeExecutionTime).toBeLessThan(25);

    // Wait for tap to complete
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(tapCompleted).toHaveBeenCalledTimes(1);
    expect(tapExecutionTime).toBeGreaterThanOrEqual(18); // Tap took its time
  });

  /**
   * @case Verify tap receives exchange snapshot with correlation
   * @preconditions Route with tap operation
   * @expectedResult Tap receives new ID and preserves correlation ID
   */
  test("tap receives exchange snapshot with correlation", async () => {
    const tapSpy = spy();
    let originalCorrelationId: string | undefined;

    t = await testContext()
      .routes(
        craft()
          .id("test-tap-snapshot")
          .from(simple({ data: "test" }))
          .to((ex) => {
            originalCorrelationId = ex.headers["routecraft.correlation_id"] as
              | string
              | undefined;
          })
          .tap(tapSpy)
          .to(() => {}),
      )
      .build();

    await t.ctx.start();

    // Wait for tap to execute
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(tapSpy.received).toHaveLength(1);
    const tapExchange = tapSpy.received[0];

    // Tap exchange should have new ID (snapshot)
    expect(tapExchange.id).toBeDefined();
    expect(typeof tapExchange.id).toBe("string");

    // Correlation ID is preserved in snapshot
    expect(tapExchange.headers["routecraft.correlation_id"]).toBe(
      originalCorrelationId,
    );
  });

  /**
   * @case A body with a clone() method is snapshotted via it, preserving its prototype
   * @preconditions A class-instance body exposing clone() and an instance method
   * @expectedResult The tapped operation receives an instance of the class, methods intact
   */
  test("clones a class-instance body via its clone() method", async () => {
    class Box {
      constructor(public value: string) {}
      clone(): Box {
        return new Box(this.value);
      }
      shout(): string {
        return this.value.toUpperCase();
      }
    }
    let received: unknown;

    t = await testContext()
      .routes(
        craft()
          .id("test-tap-clone-proto")
          .from(simple(new Box("hi")))
          .tap((ex) => {
            received = ex.body;
          })
          .to(() => {}),
      )
      .build();

    await t.ctx.start();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(received).toBeInstanceOf(Box);
    expect((received as Box).shout()).toBe("HI");
  });

  /**
   * @case A body whose clone() throws falls back instead of crashing the route
   * @preconditions A class-instance body whose clone() throws
   * @expectedResult The snapshot falls back to structuredClone; the main route completes
   */
  test("a throwing clone() does not crash the main route", async () => {
    class Bad {
      value = "x";
      clone(): Bad {
        throw new Error("boom");
      }
    }
    const reached = mock();

    t = await testContext()
      .routes(
        craft()
          .id("test-tap-clone-throws")
          .from(simple(new Bad()))
          .tap(() => {})
          .to(() => {
            reached();
          }),
      )
      .build();

    await t.ctx.start();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(reached).toHaveBeenCalledTimes(1);
  });

  /**
   * @case A plain-object body with a `clone` function field is not invoked
   * @preconditions A plain data body that happens to carry a function named clone
   * @expectedResult The clone() is not called (the protocol only applies to class instances)
   */
  test("does not invoke a clone function on a plain-object body", async () => {
    const cloneSpy = mock();
    const body = {
      value: "x",
      clone: () => {
        cloneSpy();
        return { value: "y" };
      },
    };

    t = await testContext()
      .routes(
        craft()
          .id("test-tap-plain-clone")
          .from(simple(body))
          .tap(() => {})
          .to(() => {}),
      )
      .build();

    await t.ctx.start();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(cloneSpy).not.toHaveBeenCalled();
  });

  /**
   * @case Verify tap errors don't affect main route
   * @preconditions Tap that throws an error
   * @expectedResult Route completes successfully despite tap error
   */
  test("tap errors don't affect main route", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("test-tap-error")
          .from(simple({ data: "test" }))
          .tap(async () => {
            throw new Error("Tap failed");
          })
          .to(s),
      )
      .build();

    await t.ctx.start();

    // Route should complete successfully
    expect(s.received).toHaveLength(1);
  });

  /**
   * @case Verify tap return values are ignored
   * @preconditions Tap that returns a value
   * @expectedResult Body unchanged, return value discarded
   */
  test("tap return values are ignored", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("test-tap-return")
          .from(simple({ original: "data" }))
          .tap(async () => {
            return { tapResult: "ignored" };
          })
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toEqual({ original: "data" });
  });

  /**
   * @case Verify context.stop() waits for tap jobs (route drain)
   * @preconditions Multiple slow tap operations
   * @expectedResult stop() drains routes and waits for all taps to complete
   */
  test("context.stop() waits for tap jobs via route drain", async () => {
    const tap1Completed = mock();
    const tap2Completed = mock();
    const tap3Completed = mock();

    t = await testContext()
      .routes(
        craft()
          .id("test-drain")
          .from(simple([1, 2, 3]))
          .tap(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            tap1Completed();
          })
          .tap(async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            tap2Completed();
          })
          .tap(async () => {
            await new Promise((resolve) => setTimeout(resolve, 40));
            tap3Completed();
          })
          .to(() => {}),
      )
      .build();

    await t.ctx.start();

    // stop() aborts sources then drains routes (waits for handlers + taps)
    await t.stop();

    // All taps should be completed after stop
    expect(tap1Completed).toHaveBeenCalledTimes(3); // 3 messages
    expect(tap2Completed).toHaveBeenCalledTimes(3);
    expect(tap3Completed).toHaveBeenCalledTimes(3);
  });

  /**
   * @case Verify context.stop() drains before stopping
   * @preconditions Route with tap operations
   * @expectedResult stop() waits for all tap jobs
   */
  test("context.stop() drains before stopping", async () => {
    const tapCompleted = mock();

    t = await testContext()
      .routes(
        craft()
          .id("test-stop-drain")
          .from(simple({ data: "test" }))
          .tap(async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            tapCompleted();
          })
          .to(() => {}),
      )
      .build();

    await t.ctx.start();

    // Stop should wait for tap to complete
    await t.stop();

    // Tap should be completed after stop
    expect(tapCompleted).toHaveBeenCalledTimes(1);
  });

  /**
   * @case Verify multiple taps execute in parallel
   * @preconditions Multiple tap operations in sequence
   * @expectedResult All taps execute without blocking each other
   */
  test("multiple taps execute in parallel", async () => {
    const tapOrder: number[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("test-parallel-taps")
          .from(simple({ data: "test" }))
          .tap(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            tapOrder.push(1);
          })
          .tap(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            tapOrder.push(2);
          })
          .tap(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            tapOrder.push(3);
          })
          .to(() => {}),
      )
      .build();

    await t.ctx.start();
    await t.stop();

    // Taps should complete in order of their duration (shortest first)
    // since they run in parallel
    expect(tapOrder).toEqual([3, 2, 1]);
  });
});
