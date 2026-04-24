import { type } from "arktype";
import { describe, test, expect, expectTypeOf, afterEach } from "vitest";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import {
  craft,
  BranchBuilder,
  type Source,
  type EventName,
} from "@routecraft/routecraft";

type Order = { priority: "urgent" | "normal"; amount: number };

/**
 * Emits each item in `items` as its own exchange, strictly typed. Simpler
 * than `simple([...])` which splits arrays at runtime but types the source
 * as Source<T[]>.
 */
function items<T>(list: T[]): Source<T> {
  return {
    subscribe: async (_ctx, handler) => {
      for (const item of list) {
        await handler(item);
      }
    },
  };
}

describe("choice operation", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case First matching `when` branch inlines its steps before the rest of the pipeline
   * @preconditions Route with .choice() containing two when branches and a shared downstream .to()
   * @expectedResult Each input reaches the matching branch destination and then the shared destination
   */
  test("routes to the first matching when branch and converges back", async () => {
    const urgent = spy();
    const big = spy();
    const fallback = spy();
    const shared = spy();

    const inputs: Order[] = [
      { priority: "urgent", amount: 10 },
      { priority: "normal", amount: 5000 },
    ];

    t = await testContext()
      .routes(
        craft()
          .id("choice-basic")
          .from(items(inputs))
          .choice((c) =>
            c
              .when(
                (ex) => ex.body.priority === "urgent",
                (b) => b.to(urgent),
              )
              .when(
                (ex) => ex.body.amount > 1000,
                (b) => b.to(big),
              )
              .otherwise((b) => b.to(fallback)),
          )
          .to(shared),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(urgent.received).toHaveLength(1);
    expect(urgent.received[0].body).toEqual({ priority: "urgent", amount: 10 });
    expect(big.received).toHaveLength(1);
    expect(big.received[0].body).toEqual({
      priority: "normal",
      amount: 5000,
    });
    expect(fallback.received).toHaveLength(0);
    expect(shared.received).toHaveLength(2);
  });

  /**
   * @case Unmatched exchanges are dropped when no otherwise branch exists
   * @preconditions Route with .choice() that has only `when` branches and no `.otherwise()`
   * @expectedResult Non-matching exchange does not reach the downstream destination
   */
  test("drops exchanges when no branch matches and no otherwise is defined", async () => {
    const matched = spy();
    const shared = spy();

    t = await testContext()
      .routes(
        craft()
          .id("choice-unmatched")
          .from(items<Order>([{ priority: "normal", amount: 10 }]))
          .choice((c) =>
            c.when(
              (ex) => ex.body.priority === "urgent",
              (b) => b.to(matched),
            ),
          )
          .to(shared),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(matched.received).toHaveLength(0);
    expect(shared.received).toHaveLength(0);
  });

  /**
   * @case `halt()` short-circuits the pipeline for the branch's exchange
   * @preconditions Route with .choice() whose otherwise branch calls b.to(errorSink).halt()
   * @expectedResult errorSink receives the exchange, downstream .to() does NOT run for it
   */
  test("halt() inside a branch short-circuits further processing", async () => {
    const urgent = spy();
    const errorSink = spy();
    const shared = spy();

    const inputs: Order[] = [
      { priority: "urgent", amount: 10 },
      { priority: "normal", amount: 5 },
    ];

    t = await testContext()
      .routes(
        craft()
          .id("choice-halt")
          .from(items(inputs))
          .choice((c) =>
            c
              .when(
                (ex) => ex.body.priority === "urgent",
                (b) => b.to(urgent),
              )
              .otherwise((b) => b.to(errorSink).halt()),
          )
          .to(shared),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(urgent.received).toHaveLength(1);
    expect(errorSink.received).toHaveLength(1);
    // Only the urgent exchange reaches the shared .to(); the halted one does not.
    expect(shared.received).toHaveLength(1);
    expect(shared.received[0].body).toEqual({
      priority: "urgent",
      amount: 10,
    });
  });

  /**
   * @case Choice emits `operation:choice:matched` with branchIndex and branchLabel
   * @preconditions Route with a matching when branch
   * @expectedResult matched event fires once with the expected payload
   */
  test("emits operation:choice:matched when a when branch matches", async () => {
    const sink = spy();
    const matchedEvents: Array<{
      branchIndex: number;
      branchLabel: string;
    }> = [];

    t = await testContext()
      .routes(
        craft()
          .id("choice-events-match")
          .from(items<Order>([{ priority: "urgent", amount: 10 }]))
          .choice((c) =>
            c.when(
              (ex) => ex.body.priority === "urgent",
              (b) => b.to(sink),
            ),
          ),
      )
      .on(
        "route:choice-events-match:operation:choice:matched" as EventName,
        // EventName union does not narrow handler type for dynamic route IDs
        ((payload: { details: unknown }) => {
          const d = payload.details as {
            branchIndex: number;
            branchLabel: string;
          };
          matchedEvents.push({
            branchIndex: d.branchIndex,
            branchLabel: d.branchLabel,
          });
        }) as never,
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(matchedEvents).toEqual([{ branchIndex: 0, branchLabel: "when" }]);
  });

  /**
   * @case Choice emits `operation:choice:unmatched` when no branch matches
   * @preconditions Route with a when branch whose predicate never matches and no otherwise
   * @expectedResult unmatched event fires once
   */
  test("emits operation:choice:unmatched when no branch matches", async () => {
    const sink = spy();
    let unmatchedCount = 0;

    t = await testContext()
      .routes(
        craft()
          .id("choice-events-unmatch")
          .from(items<Order>([{ priority: "normal", amount: 10 }]))
          .choice((c) =>
            c.when(
              (ex) => ex.body.priority === "urgent",
              (b) => b.to(sink),
            ),
          ),
      )
      .on(
        "route:choice-events-unmatch:operation:choice:unmatched" as EventName,
        // EventName union does not narrow handler type for dynamic route IDs
        (() => {
          unmatchedCount += 1;
        }) as never,
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(unmatchedCount).toBe(1);
    expect(sink.received).toHaveLength(0);
  });

  /**
   * @case Calling otherwise() twice on the same choice throws an authoring error
   * @preconditions Builder chain that registers two otherwise branches
   * @expectedResult The second otherwise() call throws a RoutecraftError
   */
  test("otherwise() called twice throws at build time", () => {
    expect(() =>
      craft()
        .id("choice-dup-otherwise")
        .from(items<Order>([]))
        .choice((c) =>
          c.otherwise((b) => b.to(spy())).otherwise((b) => b.to(spy())),
        )
        .build(),
    ).toThrow(/otherwise/);
  });

  /**
   * @case otherwise branch is always evaluated last regardless of registration order
   * @preconditions otherwise() called before when() in the same choice
   * @expectedResult A matching when branch wins over otherwise even when otherwise was registered first
   */
  test("otherwise always evaluates last regardless of registration order", async () => {
    const whenSink = spy();
    const otherwiseSink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("choice-otherwise-order")
          .from(items<Order>([{ priority: "urgent", amount: 1 }]))
          .choice((c) =>
            c
              .otherwise((b) => b.to(otherwiseSink))
              .when(
                (ex) => ex.body.priority === "urgent",
                (b) => b.to(whenSink),
              ),
          ),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(whenSink.received).toHaveLength(1);
    expect(otherwiseSink.received).toHaveLength(0);
  });

  /**
   * @case transform() inside a branch rewrites the body before the choice converges
   * @preconditions Two branches each transforming the body differently; shared downstream .to()
   * @expectedResult Downstream destination sees the per-branch transformed body for each exchange
   */
  test("transform() inside a branch rewrites the body before convergence", async () => {
    const shared = spy<Order>();

    const inputs: Order[] = [
      { priority: "urgent", amount: 10 },
      { priority: "normal", amount: 50 },
    ];

    t = await testContext()
      .routes(
        craft()
          .id("choice-transform-converge")
          .from(items(inputs))
          .choice((c) =>
            c
              .when(
                (ex) => ex.body.priority === "urgent",
                (b) => b.transform((body) => ({ ...body, amount: 999 })),
              )
              .otherwise((b) =>
                b.transform((body) => ({ ...body, amount: 0 })),
              ),
          )
          .to(shared),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(shared.receivedBodies()).toEqual([
      { priority: "urgent", amount: 999 },
      { priority: "normal", amount: 0 },
    ]);
  });

  /**
   * @case transform() can chain with .to() and .halt() inside the same branch
   * @preconditions Branch transforms body, sends to a sink, then halts
   * @expectedResult Sink sees the transformed body; downstream .to() is skipped due to halt
   */
  test("transform() chains with to() and halt() inside a branch", async () => {
    const sink = spy<Order>();
    const downstream = spy<Order>();

    t = await testContext()
      .routes(
        craft()
          .id("choice-transform-chain")
          .from(items<Order>([{ priority: "normal", amount: 1 }]))
          .choice((c) =>
            c.otherwise((b) =>
              b
                .transform((body) => ({ ...body, amount: body.amount + 100 }))
                .to(sink)
                .halt(),
            ),
          )
          .to(downstream),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(sink.received).toHaveLength(1);
    expect(sink.received[0].body).toEqual({ priority: "normal", amount: 101 });
    expect(downstream.received).toHaveLength(0);
  });

  /**
   * @case transform() changes the body type inside a branch; both branches must converge to the same Out
   * @preconditions Both branches call .transform to a string; downstream .to() receives strings
   * @expectedResult Downstream receives the per-branch string value; type flows through
   */
  test("transform() can change body type; branches must converge", async () => {
    const downstream = spy<string>();

    const inputs: Order[] = [
      { priority: "urgent", amount: 3 },
      { priority: "normal", amount: 4 },
    ];

    t = await testContext()
      .routes(
        craft()
          .id("choice-transform-type-change")
          .from(items(inputs))
          .choice<string>((c) =>
            c
              .when(
                (ex) => ex.body.priority === "urgent",
                (b) => b.transform((body) => `URGENT:${body.amount}`),
              )
              .otherwise((b) => b.transform((body) => `normal:${body.amount}`)),
          )
          .to(downstream),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(downstream.receivedBodies()).toEqual(["URGENT:3", "normal:4"]);
  });

  /**
   * @case transform() inside a branch awaits async (Promise-returning) transformers
   * @preconditions Branch uses an async transformer that resolves after a tick
   * @expectedResult Downstream sink sees the resolved body, proving the await is honoured inside inlined branch steps
   */
  test("transform() inside a branch awaits async transformers", async () => {
    const sink = spy<Order>();

    t = await testContext()
      .routes(
        craft()
          .id("choice-transform-async")
          .from(items<Order>([{ priority: "normal", amount: 1 }]))
          .choice((c) =>
            c.otherwise((b) =>
              b
                .transform(async (body) => {
                  await new Promise((r) => setTimeout(r, 1));
                  return { ...body, amount: body.amount + 1 };
                })
                .to(sink),
            ),
          ),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(sink.received).toHaveLength(1);
    expect(sink.received[0].body).toEqual({ priority: "normal", amount: 2 });
  });

  /**
   * @case A transformer throwing inside a branch propagates as a step failure
   * @preconditions Branch transformer throws; no route-level error handler
   * @expectedResult step:error, route:error, context:error, and exchange:failed all fire; downstream .to() does not receive the exchange
   */
  test("transform() throwing inside a branch propagates as a step failure", async () => {
    const downstream = spy<Order>();
    const events: string[] = [];

    t = await testContext()
      .on("route:*:step:*:error" as const, () => {
        events.push("step:error");
      })
      .on("route:*:error" as const, () => {
        events.push("route:error");
      })
      .on("context:error", () => {
        events.push("context:error");
      })
      .on("route:*:exchange:failed" as const, () => {
        events.push("exchange:failed");
      })
      .routes(
        craft()
          .id("choice-transform-throws")
          .from(items<Order>([{ priority: "normal", amount: 1 }]))
          .choice((c) =>
            c.otherwise((b) =>
              b.transform(() => {
                throw new Error("branch transform blew up");
              }),
            ),
          )
          .to(downstream),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(events).toContain("step:error");
    expect(events).toContain("route:error");
    expect(events).toContain("context:error");
    expect(events).toContain("exchange:failed");
    expect(downstream.received).toHaveLength(0);
  });

  /**
   * @case Type-level: BranchBuilder.transform propagates the Return generic to the next builder stage
   * @preconditions A BranchBuilder<number> transforms numbers into strings
   * @expectedResult The resulting builder is exactly BranchBuilder<string>; subsequent .to() narrows the exchange body
   */
  test("type-level: BranchBuilder.transform propagates body type", () => {
    const b = new BranchBuilder<number>();
    const b2 = b.transform((n) => n.toString());
    expectTypeOf(b2).toEqualTypeOf<BranchBuilder<string>>();
  });

  /**
   * @case enrich() inside a branch merges destination result into the body before convergence
   * @preconditions Branch uses enrich() with a destination that returns an object; default aggregator spreads result onto body
   * @expectedResult Downstream sink sees the body with the enrichment merged in
   */
  test("enrich() inside a branch merges result into the body", async () => {
    const shared = spy<Order & { reviewReason: string }>();

    t = await testContext()
      .routes(
        craft()
          .id("choice-enrich-merge")
          .from(items<Order>([{ priority: "normal", amount: 5000 }]))
          .choice((c) =>
            c.otherwise((b) =>
              b.enrich(() => ({ reviewReason: "high-value" })),
            ),
          )
          .to(shared),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(shared.received).toHaveLength(1);
    expect(shared.received[0].body).toEqual({
      priority: "normal",
      amount: 5000,
      reviewReason: "high-value",
    });
  });

  /**
   * @case enrich() inside a branch awaits async destinations
   * @preconditions Branch uses enrich() with an async destination that resolves after a tick
   * @expectedResult Downstream sink sees the merged body, proving the await is honoured inside inlined branch steps
   */
  test("enrich() inside a branch awaits async destinations", async () => {
    const sink = spy<Order & { fetched: number }>();

    t = await testContext()
      .routes(
        craft()
          .id("choice-enrich-async")
          .from(items<Order>([{ priority: "urgent", amount: 1 }]))
          .choice((c) =>
            c.otherwise((b) =>
              b
                .enrich(async () => {
                  await new Promise((r) => setTimeout(r, 1));
                  return { fetched: 42 };
                })
                .to(sink),
            ),
          ),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(sink.received).toHaveLength(1);
    expect(sink.received[0].body).toEqual({
      priority: "urgent",
      amount: 1,
      fetched: 42,
    });
  });

  /**
   * @case enrich() destination throwing inside a branch propagates as a step failure
   * @preconditions Branch enrich destination throws; no route-level error handler
   * @expectedResult step:error, route:error, context:error, and exchange:failed all fire; downstream .to() does not receive the exchange
   */
  test("enrich() destination throwing inside a branch propagates as a step failure", async () => {
    const downstream = spy<Order>();
    const events: string[] = [];

    t = await testContext()
      .on("route:*:step:*:error" as const, () => {
        events.push("step:error");
      })
      .on("route:*:error" as const, () => {
        events.push("route:error");
      })
      .on("context:error", () => {
        events.push("context:error");
      })
      .on("route:*:exchange:failed" as const, () => {
        events.push("exchange:failed");
      })
      .routes(
        craft()
          .id("choice-enrich-throws")
          .from(items<Order>([{ priority: "normal", amount: 1 }]))
          .choice((c) =>
            c.otherwise((b) =>
              b.enrich(() => {
                throw new Error("enrich fetch blew up");
              }),
            ),
          )
          .to(downstream),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(events).toContain("step:error");
    expect(events).toContain("route:error");
    expect(events).toContain("context:error");
    expect(events).toContain("exchange:failed");
    expect(downstream.received).toHaveLength(0);
  });

  /**
   * @case Type-level: BranchBuilder.enrich propagates merged body type (Current & R) to the next builder stage
   * @preconditions A BranchBuilder<{ a: number }> enriches with a destination returning { b: string }
   * @expectedResult The resulting builder is BranchBuilder<{ a: number } & { b: string }>
   */
  test("type-level: BranchBuilder.enrich propagates merged body type", () => {
    const b = new BranchBuilder<{ a: number }>();
    const b2 = b.enrich(() => ({ b: "x" }));
    expectTypeOf(b2).toEqualTypeOf<
      BranchBuilder<{ a: number } & { b: string }>
    >();
  });

  /**
   * @case filter() inside a branch drops non-matching exchanges
   * @preconditions Branch filters amount < 100; two inputs above and below threshold
   * @expectedResult Only matching exchange reaches downstream destination
   */
  test("filter() inside a branch drops non-matching exchanges", async () => {
    const downstream = spy<Order>();
    const inputs: Order[] = [
      { priority: "normal", amount: 200 },
      { priority: "normal", amount: 5 },
    ];

    t = await testContext()
      .routes(
        craft()
          .id("choice-filter-branch")
          .from(items(inputs))
          .choice((c) =>
            c.otherwise((b) => b.filter((ex) => ex.body.amount >= 100)),
          )
          .to(downstream),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(downstream.received).toHaveLength(1);
    expect(downstream.received[0].body.amount).toBe(200);
  });

  /**
   * @case header() inside a branch sets an exchange header that survives convergence
   * @preconditions Branch sets x-branch header; downstream .to() sees the header
   * @expectedResult Downstream exchange has the header set by the branch
   */
  test("header() inside a branch sets a header that survives convergence", async () => {
    const downstream = spy<Order>();

    t = await testContext()
      .routes(
        craft()
          .id("choice-header-branch")
          .from(items<Order>([{ priority: "urgent", amount: 1 }]))
          .choice((c) => c.otherwise((b) => b.header("x-branch", "otherwise")))
          .to(downstream),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(downstream.received).toHaveLength(1);
    expect(downstream.received[0].headers["x-branch"]).toBe("otherwise");
  });

  /**
   * @case tap() inside a branch runs a side effect without changing the body
   * @preconditions Branch taps a spy; downstream destination receives the unchanged exchange
   * @expectedResult Spy is invoked once; downstream body is unchanged
   */
  test("tap() inside a branch runs a side effect", async () => {
    const tapped = spy<Order>();
    const downstream = spy<Order>();

    t = await testContext()
      .routes(
        craft()
          .id("choice-tap-branch")
          .from(items<Order>([{ priority: "normal", amount: 42 }]))
          .choice((c) => c.otherwise((b) => b.tap(tapped)))
          .to(downstream),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(tapped.received).toHaveLength(1);
    expect(downstream.received).toHaveLength(1);
    expect(downstream.received[0].body).toEqual({
      priority: "normal",
      amount: 42,
    });
  });

  /**
   * @case process() inside a branch replaces the body via full-exchange access
   * @preconditions Branch processes exchange, replacing body based on a header-derived value
   * @expectedResult Downstream sees the processed body
   */
  test("process() inside a branch replaces the body", async () => {
    const downstream = spy<{ tag: string }>();

    t = await testContext()
      .routes(
        craft()
          .id("choice-process-branch")
          .from(items<Order>([{ priority: "urgent", amount: 1 }]))
          .choice<{ tag: string }>((c) =>
            c.otherwise((b) =>
              b.process<{ tag: string }>((ex) => ({
                ...ex,
                body: { tag: `${ex.body.priority}:${ex.body.amount}` },
              })),
            ),
          )
          .to(downstream),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(downstream.received).toHaveLength(1);
    expect(downstream.received[0].body).toEqual({ tag: "urgent:1" });
  });

  /**
   * @case validate() inside a branch throws on invalid input (routes to error handler)
   * @preconditions Branch validates with a predicate that always throws
   * @expectedResult step:error and exchange:failed fire; downstream does not receive the exchange
   */
  test("validate() inside a branch surfaces failures", async () => {
    const downstream = spy<Order>();
    const events: string[] = [];

    t = await testContext()
      .on("route:*:step:*:error" as const, () => {
        events.push("step:error");
      })
      .on("route:*:exchange:failed" as const, () => {
        events.push("exchange:failed");
      })
      .routes(
        craft()
          .id("choice-validate-branch")
          .from(items<Order>([{ priority: "urgent", amount: 1 }]))
          .choice((c) =>
            c.otherwise((b) =>
              b.validate(() => {
                throw new Error("validation failed");
              }),
            ),
          )
          .to(downstream),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(events).toContain("step:error");
    expect(events).toContain("exchange:failed");
    expect(downstream.received).toHaveLength(0);
  });

  /**
   * @case Sugar methods (log / map) are callable inside a branch at both runtime and type level
   * @preconditions Branch uses .map() to reshape body, then downstream sink receives mapped shape
   * @expectedResult Sugar methods registered via registerDsl on the shared base work inside branches
   */
  test("sugar methods (.map, .log) work inside a branch", async () => {
    const downstream = spy<{ label: string }>();

    t = await testContext()
      .routes(
        craft()
          .id("choice-sugar-branch")
          .from(items<Order>([{ priority: "normal", amount: 99 }]))
          .choice<{ label: string }>((c) =>
            c.otherwise((b) =>
              b.log().map<{ label: string }>({
                label: (src) => `${src.priority}-${src.amount}`,
              }),
            ),
          )
          .to(downstream),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(downstream.received).toHaveLength(1);
    expect(downstream.received[0].body).toEqual({ label: "normal-99" });
  });

  /**
   * @case Type-level: BranchBuilder inherits the type-preserving ops correctly
   * @preconditions A BranchBuilder<T> calls filter / header / tap
   * @expectedResult Each returns BranchBuilder<T> (same subclass, same body type)
   */
  test("type-level: type-preserving ops on BranchBuilder return BranchBuilder<T>", () => {
    const b = new BranchBuilder<Order>();
    const afterFilter = b.filter(() => true);
    const afterHeader = b.header("k", "v");
    const afterTap = b.tap(() => undefined);
    expectTypeOf(afterFilter).toEqualTypeOf<BranchBuilder<Order>>();
    expectTypeOf(afterHeader).toEqualTypeOf<BranchBuilder<Order>>();
    expectTypeOf(afterTap).toEqualTypeOf<BranchBuilder<Order>>();
  });

  /**
   * @case debug() sugar is callable inside a branch (runtime + inheritance)
   * @preconditions Branch chains .debug() followed by .to() to a sink
   * @expectedResult Debug tap runs as a fire-and-forget side effect; sink receives the unchanged exchange
   */
  test(".debug() sugar works inside a branch", async () => {
    const downstream = spy<Order>();

    t = await testContext()
      .routes(
        craft()
          .id("choice-sugar-debug-branch")
          .from(items<Order>([{ priority: "urgent", amount: 7 }]))
          .choice((c) => c.otherwise((b) => b.debug().to(downstream))),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(downstream.received).toHaveLength(1);
    expect(downstream.received[0].body).toEqual({
      priority: "urgent",
      amount: 7,
    });
  });

  /**
   * @case schema() sugar validates inside a branch and narrows the body type
   * @preconditions Branch uses .schema() with an arktype schema; input satisfies the schema
   * @expectedResult Downstream receives the validated exchange; body type is the schema's inferred output
   */
  test(".schema() sugar works inside a branch", async () => {
    const downstream = spy<{ priority: string; amount: number }>();
    const orderSchema = type({ priority: "string", amount: "number" });

    t = await testContext()
      .routes(
        craft()
          .id("choice-sugar-schema-branch")
          .from(items<Order>([{ priority: "normal", amount: 5 }]))
          .choice<{ priority: string; amount: number }>((c) =>
            c.otherwise((b) => b.schema(orderSchema)),
          )
          .to(downstream),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(downstream.received).toHaveLength(1);
    expect(downstream.received[0].body).toEqual({
      priority: "normal",
      amount: 5,
    });
  });
});
