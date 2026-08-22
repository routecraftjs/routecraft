import { afterEach, describe, expect, test } from "bun:test";
import { craft, direct, noop, simple } from "../src/index.ts";
import { spy, testContext, type TestContext } from "@routecraft/testing";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The two stages of shutdown, and the deadline between them.
 *
 * Stage one closes intake and drains: sources stop producing, and an
 * exchange already in the pipeline runs to its natural end. Stage two is
 * forced, either by a second signal or by `shutdown.timeoutMs` elapsing, and
 * abandons in-flight execution.
 *
 * The bound exists because an unbounded stage one hands the outcome to the
 * platform's kill timer: under an orchestrator there is no second Ctrl-C
 * coming, only SIGKILL, and everything stage two meant to do is lost.
 */
describe("bounded graceful shutdown", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Stage one drains an in-flight exchange to its natural end and exits clean
   * @preconditions A step that takes longer than the gap between dispatch and stop(), well inside the deadline
   * @expectedResult The step completes, its result reaches the destination, and the outcome reports not forced with nothing pending
   */
  test("drains in-flight work rather than cancelling it", async () => {
    const sink = spy();
    let completed = false;

    t = await testContext()
      .with({ shutdown: { timeoutMs: 5_000 } })
      .routes(
        craft()
          .id("slow")
          .from(direct())
          .transform(async (body: unknown) => {
            await sleep(150);
            completed = true;
            return body;
          })
          .to(sink),
      )
      .build();
    await t.startAndWaitReady();

    const dispatch = t.client.sendDirect("slow", "payload");
    await sleep(20);

    const outcome = await t.ctx.stop();
    await dispatch;

    expect(completed).toBe(true);
    expect(sink.received).toHaveLength(1);
    expect(outcome).toEqual({ forced: false, pending: [] });
    t = undefined;
  });

  /**
   * @case The deadline forces stage two and names what it abandoned
   * @preconditions A step that never settles, and a short shutdown.timeoutMs
   * @expectedResult stop() resolves forced, pending names the route, and the route's execution signal has fired
   */
  test("forces stage two at the deadline and names the pending route", async () => {
    let sawExecutionAbort = false;

    t = await testContext()
      .with({ shutdown: { timeoutMs: 250 } })
      .routes(
        craft()
          .id("wedged")
          .from(direct())
          .transform(
            () =>
              new Promise(() => {
                // Never settles: this is the hung route the deadline exists for.
              }),
          )
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();

    const route = t.ctx.getRoutes()[0];
    route?.signal.addEventListener("abort", () => {
      sawExecutionAbort = true;
    });

    void t.client.sendDirect("wedged", "payload").catch(() => undefined);
    await sleep(20);

    const started = Date.now();
    const outcome = await t.ctx.stop();
    const elapsed = Date.now() - started;

    expect(outcome.forced).toBe(true);
    expect(outcome.pending).toEqual(["wedged"]);
    expect(sawExecutionAbort).toBe(true);
    // Bounded: it returned near the deadline rather than waiting the wedged
    // step out, which is the whole point of the key.
    expect(elapsed).toBeLessThan(3_000);
    t = undefined;
  });

  /**
   * @case Closing intake does not fire the execution signal
   * @preconditions A running route with nothing in flight
   * @expectedResult stop() aborts intake but leaves the execution signal untouched until the forced stage, which never runs here because the drain completes
   */
  test("stage one aborts intake without touching execution", async () => {
    t = await testContext()
      .routes(craft().id("quiet").from(direct()).to(noop()))
      .build();
    await t.startAndWaitReady();

    const route = t.ctx.getRoutes()[0];
    expect(route?.intakeSignal.aborted).toBe(false);
    expect(route?.signal.aborted).toBe(false);

    const outcome = await t.ctx.stop();

    expect(route?.intakeSignal.aborted).toBe(true);
    expect(route?.signal.aborted).toBe(false);
    expect(outcome.forced).toBe(false);
    t = undefined;
  });

  /**
   * @case A finite source completing does not cancel exchanges it already emitted
   * @preconditions A finite source emitting one message into a step slower than the source's own completion
   * @expectedResult The exchange completes and reaches the destination, because source completion closes intake only
   */
  test("a finite source completing leaves its emitted work running", async () => {
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("finite")
          .from(simple("only"))
          .transform(async (body: unknown) => {
            await sleep(80);
            return body;
          })
          .to(sink),
      )
      .build();

    await t.test();

    expect(sink.received).toHaveLength(1);
    t = undefined;
  });
});
