import { afterEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import {
  craft,
  direct,
  event,
  HeadersKeys,
  simple,
  type Exchange,
  type EventPayload,
} from "@routecraft/routecraft";
import { lineageOf } from "../src/lineage.ts";
import { childBindings } from "../src/logger.ts";

/** The correlation and causation ids an exchange carries. */
function ids(exchange: Exchange): {
  id: string;
  correlationId: string;
  causationId: string | undefined;
} {
  return {
    id: exchange.id,
    correlationId: exchange.headers[HeadersKeys.CORRELATION_ID] as string,
    causationId: exchange.headers[HeadersKeys.CAUSATION_ID] as
      string | undefined,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Causation", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case A direct() call records the caller as the callee's cause
   * @preconditions A caller route sends to a callee through a direct() destination
   * @expectedResult The callee carries the caller's correlation id and the caller's exchange id as its causation id; the caller, a chain root, has none
   */
  test("direct(): the callee's cause is the caller", async () => {
    const seen: Record<string, ReturnType<typeof ids>> = {};
    t = await testContext()
      .routes([
        craft()
          .id("caller")
          .from(simple("ping"))
          .process((ex) => {
            seen["caller"] = ids(ex);
            return ex;
          })
          .to(direct("callee")),
        craft()
          .id("callee")
          .from(direct())
          .process((ex) => {
            seen["callee"] = ids(ex);
            return ex;
          })
          .to(() => "pong"),
      ])
      .build();
    await t.test();

    const caller = seen["caller"]!;
    const callee = seen["callee"]!;
    expect(caller.causationId).toBeUndefined();
    expect(callee.correlationId).toBe(caller.correlationId);
    expect(callee.causationId).toBe(caller.id);
  });

  /**
   * @case forward() from an error handler records the failed exchange as the target's cause
   * @preconditions A route whose step throws forwards from its .error() handler to a second route
   * @expectedResult The target's correlation id is the failed exchange's and its causation id is the failed exchange's id
   */
  test("forward(): the target's cause is the failed exchange", async () => {
    let failed: ReturnType<typeof ids> | undefined;
    let target: ReturnType<typeof ids> | undefined;
    t = await testContext()
      .routes([
        craft()
          .id("fails")
          .error((_error, _exchange, forward) =>
            forward("report" as never, { about: "failure" }),
          )
          .from(simple("go"))
          .process((ex) => {
            failed = ids(ex);
            return ex;
          })
          .transform(() => {
            throw new Error("boom");
          })
          .to(spy()),
        craft()
          .id("report")
          .from(direct())
          .process((ex) => {
            target = ids(ex);
            return ex;
          })
          .to(spy()),
      ])
      .build();
    await t.test();

    expect(target?.correlationId).toBe(failed!.correlationId);
    expect(target?.causationId).toBe(failed!.id);
  });

  /**
   * @case A multicast path runs as a clone caused by the original
   * @preconditions A route multicasts to a sub-pipeline that records its exchange
   * @expectedResult The path's exchange has a fresh id, the original's correlation id, and the original's id as its cause
   */
  test("multicast: a path's cause is the original", async () => {
    let original: ReturnType<typeof ids> | undefined;
    let path: ReturnType<typeof ids> | undefined;
    t = await testContext()
      .routes(
        craft()
          .id("fans-out")
          .from(simple("go"))
          .process((ex) => {
            original = ids(ex);
            return ex;
          })
          .multicast((b) => b.to((ex) => {
            path = ids(ex);
          }))
          .to(spy()),
      )
      .build();
    await t.test();

    expect(path?.id).not.toBe(original!.id);
    expect(path?.correlationId).toBe(original!.correlationId);
    expect(path?.causationId).toBe(original!.id);
  });

  /**
   * @case A split child's cause is the exchange that was split
   * @preconditions A route splits an array body and records each child
   * @expectedResult Every child carries the parent's correlation id and the parent's id as its cause
   */
  test("split: every child's cause is the parent", async () => {
    let parent: ReturnType<typeof ids> | undefined;
    const children: ReturnType<typeof ids>[] = [];
    t = await testContext()
      .routes(
        craft()
          .id("splits")
          .from(simple({ items: [1, 2, 3] }))
          .process((ex) => {
            parent = ids(ex);
            return ex;
          })
          .split((ex) => ex.body.items)
          .process((ex) => {
            children.push(ids(ex));
            return ex;
          })
          .aggregate()
          .to(spy()),
      )
      .build();
    await t.test();

    expect(children).toHaveLength(3);
    for (const child of children) {
      expect(child.correlationId).toBe(parent!.correlationId);
      expect(child.causationId).toBe(parent!.id);
    }
  });

  /**
   * @case A tap's snapshot records the exchange it was taken from as its cause
   * @preconditions A route taps and records what the tap receives
   * @expectedResult The snapshot's causation id is the tapped exchange's id
   */
  test("tap: the snapshot's cause is the tapped exchange", async () => {
    let tapped: ReturnType<typeof ids> | undefined;
    let snapshot: ReturnType<typeof ids> | undefined;
    t = await testContext()
      .routes(
        craft()
          .id("taps")
          .from(simple("go"))
          .process((ex) => {
            tapped = ids(ex);
            return ex;
          })
          .tap((ex) => {
            snapshot = ids(ex);
          })
          .to(spy()),
      )
      .build();
    await t.test();

    expect(snapshot?.causationId).toBe(tapped!.id);
    expect(snapshot?.correlationId).toBe(tapped!.correlationId);
  });

  /**
   * @case A debounce release records the held arrival as its cause
   * @preconditions A route debounces one arrival with a long window; drain flushes the hold
   * @expectedResult The released exchange carries the arrival's correlation id and its id as the cause
   */
  test("debounce: the release's cause is the held arrival", async () => {
    let arrival: ReturnType<typeof ids> | undefined;
    let released: ReturnType<typeof ids> | undefined;
    t = await testContext()
      .routes(
        craft()
          .id("debounces")
          .from(simple("go"))
          .process((ex) => {
            arrival = ids(ex);
            return ex;
          })
          .debounce({ wait: 10_000 })
          .to((ex) => {
            released = ids(ex);
          }),
      )
      .build();
    await t.ctx.start();
    await delay(20);
    await t.drain();

    expect(released?.causationId).toBe(arrival!.id);
    expect(released?.correlationId).toBe(arrival!.correlationId);
  });

  /**
   * @case An event() delivery continues the journey of the exchange that caused the event
   * @preconditions A watcher consumes route:exchange:completed; a worker runs one exchange
   * @expectedResult The watcher's exchange carries the worker exchange's correlation id and its id as the cause, and its route:exchange:started event carries the causationId
   */
  test("event(): a delivery continues the causing exchange's chain", async () => {
    let worker: ReturnType<typeof ids> | undefined;
    let watcher: ReturnType<typeof ids> | undefined;
    const started: Array<{ routeId: string; causationId?: string }> = [];
    t = await testContext()
      .routes([
        craft()
          .id("watcher")
          .from(event("route:exchange:completed"))
          .to((ex) => {
            watcher = ids(ex);
          }),
        craft()
          .id("worker")
          .from(simple("go"))
          .process((ex) => {
            worker = ids(ex);
            return ex;
          })
          .to(spy()),
      ])
      .on("route:exchange:started", ((payload: EventPayload<never>) => {
        started.push(
          payload.details as { routeId: string; causationId?: string },
        );
      }) as never)
      .build();
    await t.test();

    expect(watcher?.correlationId).toBe(worker!.correlationId);
    expect(watcher?.causationId).toBe(worker!.id);
    const watcherStart = started.find((s) => s.routeId === "watcher");
    expect(watcherStart?.causationId).toBe(worker!.id);
    expect(
      started.find((s) => s.routeId === "worker")?.causationId,
    ).toBeUndefined();
  });

  /**
   * @case An event() route still receives the rest of the causing chain while it handles one of its events
   * @preconditions A worker calls a second route through direct(); a watcher consumes route:exchange:completed and is still running when the worker's own exchange completes
   * @expectedResult The watcher receives both completions, the callee's and the worker's, although they share the correlation id of the exchange it is handling
   */
  test("event(): the causing chain's other exchanges are still delivered", async () => {
    const seen: string[] = [];
    t = await testContext()
      .routes([
        craft()
          .id("slow-watcher")
          .from(event("route:exchange:completed"))
          .process(async (ex) => {
            await delay(30);
            return ex;
          })
          .to((ex) => {
            seen.push(
              (ex.body as { details: { routeId: string } }).details.routeId,
            );
          }),
        craft()
          .id("chain-worker")
          .from(simple("go"))
          .to(direct("chain-callee")),
        craft()
          .id("chain-callee")
          .from(direct())
          .to(() => "done"),
      ])
      .build();
    await t.test();
    await t.drain();

    expect(seen.sort()).toEqual(["chain-callee", "chain-worker"]);
  });

  /**
   * @case The lineage index is empty once every exchange has finished
   * @preconditions A route that calls another through direct(), multicasts and splits runs to completion
   * @expectedResult No entry is left behind
   */
  test("lineage: nothing outlives its exchange", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("lineage-root")
          .from(simple([1, 2]))
          .multicast((b) => b.to(spy()))
          .split()
          .to(direct("lineage-leaf"))
          .aggregate()
          .to(spy()),
        craft()
          .id("lineage-leaf")
          .from(direct())
          .to(() => "ok"),
      ])
      .build();
    await t.test();
    await t.drain();

    expect(lineageOf(t.ctx).size).toBe(0);
  });

  /**
   * @case .correlate() joins the exchange to another journey and records the stitch
   * @preconditions A route correlates onto fixed ids, then calls a second route through direct()
   * @expectedResult The exchange and its callee carry the new correlation id, the callee's cause is the re-stamped exchange, route:exchange:correlated carries the old and new ids, :completed carries the new correlation id, and the logger bindings name the new ids
   */
  test(".correlate(): re-stamps the exchange and emits the edge", async () => {
    const correlated: Array<Record<string, unknown>> = [];
    const completed: Array<{ routeId: string; correlationId: string }> = [];
    let before: ReturnType<typeof ids> | undefined;
    let after: ReturnType<typeof ids> | undefined;
    let callee: ReturnType<typeof ids> | undefined;
    let bindings: Record<string, unknown> | undefined;
    t = await testContext()
      .routes([
        craft()
          .id("stitches")
          .from(simple("webhook"))
          .process((ex) => {
            before = ids(ex);
            return ex;
          })
          .correlate(() => ({
            correlationId: "story-42",
            causationId: "creator-exchange",
          }))
          .process((ex) => {
            after = ids(ex);
            bindings = childBindings(ex);
            return ex;
          })
          .to(direct("stitched-callee")),
        craft()
          .id("stitched-callee")
          .from(direct())
          .process((ex) => {
            callee = ids(ex);
            return ex;
          })
          .to(spy()),
      ])
      .on("route:exchange:correlated", ((payload: EventPayload<never>) => {
        correlated.push(payload.details as Record<string, unknown>);
      }) as never)
      .on("route:exchange:completed", ((payload: EventPayload<never>) => {
        completed.push(
          payload.details as { routeId: string; correlationId: string },
        );
      }) as never)
      .build();
    await t.test();

    expect(after?.id).toBe(before!.id);
    expect(after?.correlationId).toBe("story-42");
    expect(after?.causationId).toBe("creator-exchange");
    expect(bindings?.["correlationId"]).toBe("story-42");
    expect(bindings?.["causationId"]).toBe("creator-exchange");
    expect(callee?.correlationId).toBe("story-42");
    expect(callee?.causationId).toBe(before!.id);
    expect(correlated).toEqual([
      {
        routeId: "stitches",
        exchangeId: before!.id,
        correlationId: "story-42",
        causationId: "creator-exchange",
        previous: { correlationId: before!.correlationId },
      },
    ]);
    expect(completed.find((c) => c.routeId === "stitches")?.correlationId).toBe(
      "story-42",
    );
  });

  /**
   * @case .correlate() with a falsy result leaves the exchange as it is
   * @preconditions A route whose correlator finds nothing
   * @expectedResult The correlation id is unchanged and no route:exchange:correlated is emitted
   */
  test(".correlate(): a falsy result is a no-op", async () => {
    let correlated = 0;
    let before: ReturnType<typeof ids> | undefined;
    let after: ReturnType<typeof ids> | undefined;
    t = await testContext()
      .routes(
        craft()
          .id("finds-nothing")
          .from(simple("x"))
          .process((ex) => {
            before = ids(ex);
            return ex;
          })
          .correlate(() => undefined)
          .to((ex) => {
            after = ids(ex);
          }),
      )
      .on("route:exchange:correlated", (() => {
        correlated++;
      }) as never)
      .build();
    await t.test();

    expect(after).toEqual(before);
    expect(correlated).toBe(0);
  });

  /**
   * @case .correlate() refuses an id that is not well formed
   * @preconditions A route correlates onto an id containing a space
   * @expectedResult The exchange fails with RC5003 and the downstream step never runs
   */
  test(".correlate(): a malformed id fails the step with RC5003", async () => {
    const downstream = spy();
    t = await testContext()
      .routes(
        craft()
          .id("bad-stitch")
          .from(simple("x"))
          .correlate(() => ({ correlationId: "not an id" }))
          .to(downstream),
      )
      .build();
    await t.test();

    expect(downstream.received).toHaveLength(0);
    expect(t.errors.some((e) => e.rc === "RC5003")).toBe(true);
  });

  /**
   * @case A CraftClient call with a malformed correlation id is refused at ingress
   * @preconditions A direct route; sendDirect supplies a correlation id longer than 128 characters
   * @expectedResult The call rejects with RC5003
   */
  test("ingress refuses a malformed correlation id from code", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("client-target")
          .from(direct())
          .to(() => "ok"),
      )
      .build();
    await t.startAndWaitReady();
    await expect(
      t.client.sendDirect("client-target", "x", {
        [HeadersKeys.CORRELATION_ID]: "a".repeat(129),
      }),
    ).rejects.toMatchObject({ rc: "RC5003" });
  });
});
