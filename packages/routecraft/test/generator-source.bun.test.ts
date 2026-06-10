import { afterEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft } from "../src/index.ts";

describe("generator and iterable sources", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case An async generator function drives a route, one exchange per yield
   * @preconditions .from(async function* (sub) { yield 1; yield 2; yield 3; })
   * @expectedResult Sink receives the three bodies in order; route completes
   */
  test("async generator function emits one exchange per yield", async () => {
    const sink = spy<number>();
    t = await testContext()
      .routes(
        craft()
          .id("gen")
          .from<number>(async function* () {
            yield 1;
            yield 2;
            yield 3;
          })
          .to(sink),
      )
      .build();

    await t.ctx.start();
    expect(sink.received.map((e) => e.body)).toEqual([1, 2, 3]);
  });

  /**
   * @case A sync generator function works the same as an async one
   * @preconditions .from(function* () { yield "a"; yield "b"; })
   * @expectedResult Sink receives both bodies in order
   */
  test("sync generator function emits one exchange per yield", async () => {
    const sink = spy<string>();
    t = await testContext()
      .routes(
        craft()
          .id("sync-gen")
          .from<string>(function* () {
            yield "a";
            yield "b";
          })
          .to(sink),
      )
      .build();

    await t.ctx.start();
    expect(sink.received.map((e) => e.body)).toEqual(["a", "b"]);
  });

  /**
   * @case The generator receives the Subscription and can stop on abort
   * @preconditions Infinite generator checking sub.signal.aborted each tick
   * @expectedResult Generator observes the abort and the route stops cleanly
   */
  test("generator observes sub.signal for cooperative shutdown", async () => {
    const sink = spy<number>();
    let lastSeen = -1;
    t = await testContext()
      .routes(
        craft()
          .id("gen-abort")
          .from<number>(async function* (sub) {
            let i = 0;
            while (!sub.signal.aborted) {
              lastSeen = i;
              yield i++;
              await new Promise((r) => setTimeout(r, 1));
            }
          })
          .to(sink),
      )
      .build();

    await t.startAndWaitReady();
    await new Promise((r) => setTimeout(r, 20));
    await t.stop();
    t = undefined;

    expect(lastSeen).toBeGreaterThanOrEqual(1);
    expect(sink.received.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * @case A bare async iterable drives a route
   * @preconditions .from(asyncIterableOf(["x", "y"]))
   * @expectedResult Sink receives both bodies; route completes
   */
  test("bare async iterable emits its items", async () => {
    const sink = spy<string>();
    const iterable: AsyncIterable<string> = {
      async *[Symbol.asyncIterator]() {
        yield "x";
        yield "y";
      },
    };
    t = await testContext()
      .routes(craft().id("iterable").from<string>(iterable).to(sink))
      .build();

    await t.ctx.start();
    expect(sink.received.map((e) => e.body)).toEqual(["x", "y"]);
  });

  /**
   * @case A failing exchange does not stop the generator
   * @preconditions Transform throws for one of three yielded items
   * @expectedResult The other two reach the sink; iteration continues
   */
  test("per-item pipeline failure does not kill the source", async () => {
    const sink = spy<number>();
    t = await testContext()
      .routes(
        craft()
          .id("gen-fail")
          .from<number>(async function* () {
            yield 1;
            yield 2;
            yield 3;
          })
          .transform((n) => {
            if (n === 2) throw new Error("boom");
            return n;
          })
          .to(sink),
      )
      .build();

    await t.ctx.start();
    expect(sink.received.map((e) => e.body)).toEqual([1, 3]);
  });
});
