import { describe, test, expect, afterEach, vi } from "vitest";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import {
  craft,
  direct,
  ErrorWrapperStep,
  simple,
  WrapperStep,
  type Step,
  type Adapter,
  type Exchange,
} from "@routecraft/routecraft";

describe(".error() step scope: dual-mode wrapper", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Step-scope handler recovers a single failure and the pipeline continues
   * @preconditions .from(...).transform(throws).error(recover).to(sink)
   * @expectedResult Sink receives the handler's return; route reports zero errors
   */
  test("step-scope recovery continues the pipeline", async () => {
    const sink = spy();
    t = await testContext()
      .routes(
        craft()
          .id("step-recovers")
          .from(simple("input"))
          .error(() => ({ recovered: true }))
          .transform(() => {
            throw new Error("boom");
          })
          .to(sink),
      )
      .build();

    await t.test();
    expect(t.errors).toHaveLength(0);
    expect(sink.received).toHaveLength(1);
    expect(sink.received[0].body).toEqual({ recovered: true });
  });

  /**
   * @case Wrapper attaches to the immediately next step only
   * @preconditions .error(h).transform(ok).transform(throw); h does NOT cover the second transform
   * @expectedResult Route's default error path fires; sink not reached
   */
  test("wrapper covers only the next step, not later steps", async () => {
    const sink = spy();
    const handler = vi.fn(() => ({ shouldNotRun: true }));
    t = await testContext()
      .routes(
        craft()
          .id("scope-only-next")
          .from(simple("input"))
          .error(handler)
          .transform((b) => `${b}-ok`)
          .transform(() => {
            throw new Error("from-second");
          })
          .to(sink),
      )
      .build();

    await t.test();
    // Handler not invoked because the throw happened on the unwrapped second transform.
    expect(handler).not.toHaveBeenCalled();
    expect(sink.received).toHaveLength(0);
    expect(t.errors[0]?.message).toMatch(/from-second/);
  });

  /**
   * @case Stacked wrappers fold outside-in (first declared is outermost)
   * @preconditions Two synthetic wrappers stacked; outer rethrows test marker, inner unused
   * @expectedResult Outer wrapper observes the inner wrapper's adapter (its `inner` is the inner wrapper)
   */
  test("stacked step wrappers fold outside-in", async () => {
    // Two minimal trace wrappers that just record their own position in the stack.
    const calls: string[] = [];
    class TraceWrapperOuter extends WrapperStep {
      protected override async runInner(
        exchange: Exchange,
        innerQueue: { exchange: Exchange; steps: Step<Adapter>[] }[],
      ): Promise<"ok"> {
        calls.push("outer-before");
        await this.inner.execute(exchange, [], innerQueue);
        calls.push("outer-after");
        return "ok";
      }
    }
    class TraceWrapperInner extends WrapperStep {
      protected override async runInner(
        exchange: Exchange,
        innerQueue: { exchange: Exchange; steps: Step<Adapter>[] }[],
      ): Promise<"ok"> {
        calls.push("inner-before");
        await this.inner.execute(exchange, [], innerQueue);
        calls.push("inner-after");
        return "ok";
      }
    }

    // Hand-build: outer wraps inner wraps the to step. We can't easily
    // express "stack two wrapper factories" through the public builder
    // until a second public wrapper ships, so wire the wrap chain
    // directly via the builder's pending stack via a thin helper.
    const sink = spy();
    type WrapBuilder = {
      pendingStepWrappers: Array<(s: Step<Adapter>) => Step<Adapter>>;
    };
    const builder = craft().id("stacked-wrappers").from(simple("hi"));
    (builder as unknown as WrapBuilder).pendingStepWrappers.push(
      (inner) => new TraceWrapperOuter(inner),
    );
    (builder as unknown as WrapBuilder).pendingStepWrappers.push(
      (inner) => new TraceWrapperInner(inner),
    );

    t = await testContext().routes(builder.to(sink)).build();
    await t.test();

    // Outer surrounds inner: outer-before, inner-before, inner-after, outer-after.
    expect(calls).toEqual([
      "outer-before",
      "inner-before",
      "inner-after",
      "outer-after",
    ]);
    expect(sink.received).toHaveLength(1);
  });

  /**
   * @case Step handler throws; route-level handler catches the rethrow
   * @preconditions Route .error(routeHandler) before .from(); step .error(throws) after
   * @expectedResult Route handler invoked with the (wrapped) handler error; pipeline halts after route handler (existing semantics)
   */
  test("step handler throw escalates to route handler", async () => {
    const routeHandler = vi.fn(() => ({ caughtAtRoute: true }));
    const sink = spy();
    t = await testContext()
      .routes(
        craft()
          .id("escalate-to-route")
          .error(routeHandler)
          .from(simple("input"))
          .error(() => {
            throw new Error("step-handler-failure");
          })
          .transform(() => {
            throw new Error("step-failure");
          })
          .to(sink),
      )
      .build();

    await t.test();
    expect(routeHandler).toHaveBeenCalledTimes(1);
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case Step handler throws with no route-level handler; default error path fires
   * @preconditions No route-level .error(); step .error(throws); transform throws
   * @expectedResult t.errors records the failure; route is NOT stopped (next exchange still processes)
   */
  test("step handler throw without route handler hits default path", async () => {
    const sink = spy();
    t = await testContext()
      .routes(
        craft()
          .id("escalate-no-route")
          .from(simple("input"))
          .error(() => {
            throw new Error("step-handler-failure");
          })
          .transform(() => {
            throw new Error("step-failure");
          })
          .to(sink),
      )
      .build();

    await t.test();
    expect(t.errors[0]?.message).toMatch(
      /step-handler-failure|step-failure|threw/i,
    );
    expect(sink.received).toHaveLength(0);
  });

  /**
   * @case Step handler uses forward() to delegate recovery to a direct route
   * @preconditions DLQ direct route registered; step handler returns forward(dlq, payload)
   * @expectedResult DLQ receives the payload; pipeline continues with forward()'s return as the body
   */
  test("step handler can forward() to a direct route", async () => {
    const dlqSink = spy();
    const sink = spy();
    t = await testContext()
      .routes([
        craft().id("dlq").from(direct()).to(dlqSink),
        craft()
          .id("with-step-forward")
          .from(simple("input"))
          .error((err, _ex, forward) => forward("dlq", { reason: String(err) }))
          .transform(() => {
            throw new Error("boom");
          })
          .to(sink),
      ])
      .build();

    await t.test();
    expect(dlqSink.received).toHaveLength(1);
    expect(dlqSink.received[0].body).toMatchObject({
      reason: expect.stringMatching(/boom/),
    });
    expect(sink.received).toHaveLength(1);
  });

  /**
   * @case Combined route + step handlers; happy path through the step recovery
   * @preconditions Route .error() set; step .error() set; only step throws
   * @expectedResult Step handler runs; route handler is never invoked
   */
  test("step handler short-circuits the route handler on success", async () => {
    const routeHandler = vi.fn(() => ({ shouldNotRun: true }));
    const sink = spy();
    t = await testContext()
      .routes(
        craft()
          .id("step-wins")
          .error(routeHandler)
          .from(simple("input"))
          .error(() => ({ stepRecovered: true }))
          .transform(() => {
            throw new Error("step-failure");
          })
          .to(sink),
      )
      .build();

    await t.test();
    expect(routeHandler).not.toHaveBeenCalled();
    expect(sink.received[0].body).toEqual({ stepRecovered: true });
  });

  /**
   * @case error-handler events carry scope and stepLabel for step-scope wrappers
   * @preconditions Subscriber to route:*:error-handler:* before t.test()
   * @expectedResult invoked + recovered events both carry scope: "step" and a stepLabel
   */
  test("error-handler events carry scope and stepLabel for step scope", async () => {
    const events: Array<{ name: string; details: unknown }> = [];
    t = await testContext()
      .routes(
        craft()
          .id("event-scope")
          .from(simple("input"))
          .error(() => "recovered")
          .transform(() => {
            throw new Error("boom");
          })
          .to(spy()),
      )
      .build();

    t.ctx.on(
      "route:event-scope:error-handler:invoked" as never,
      ({ details }: { details: unknown }) => {
        events.push({ name: "invoked", details });
      },
    );
    t.ctx.on(
      "route:event-scope:error-handler:recovered" as never,
      ({ details }: { details: unknown }) => {
        events.push({ name: "recovered", details });
      },
    );

    await t.test();
    expect(events.map((e) => e.name)).toEqual(["invoked", "recovered"]);
    for (const e of events) {
      const d = e.details as {
        scope?: string;
        stepLabel?: string;
        failedOperation?: string;
      };
      expect(d.scope).toBe("step");
      expect(d.stepLabel).toBeDefined();
    }
  });

  /**
   * @case Concurrent execute() calls on one wrapper instance do not share inner-queue state
   * @preconditions Single ErrorWrapperStep instance; fire 10 concurrent execute() calls with overlapping inner work
   * @expectedResult Each call's inner-pushed children land in the right per-call queue; no cross-talk
   */
  test("concurrent execute() calls share no per-execution buffer state", async () => {
    // Hand-build a wrapper unit test (no testContext) to avoid the
    // start/stop race that would come from calling `t.test()` in
    // parallel on a single TestContext. The bug we want to detect is
    // wrapper-internal: per-execution buffers must not leak across
    // concurrent calls into the same instance.

    // Fake inner step that yields the event loop then pushes ONE
    // child whose body identifies the originating exchange. If the
    // wrapper aliases per-instance state, a child will end up in the
    // wrong outer queue.
    const innerStep: Step<Adapter> = {
      operation: "transform" as Step<Adapter>["operation"],
      adapter: { adapterId: "fake.inner" } as unknown as Adapter,
      async execute(
        exchange: Exchange,
        _remainingSteps: Step<Adapter>[],
        queue: { exchange: Exchange; steps: Step<Adapter>[] }[],
      ): Promise<void> {
        // Yield so multiple execute() invocations interleave.
        await new Promise((r) => setTimeout(r, 1));
        queue.push({ exchange, steps: [] });
      },
    };
    const wrapper = new ErrorWrapperStep(innerStep, () => "unused");

    const N = 10;
    const outerQueues: {
      exchange: Exchange;
      steps: Step<Adapter>[];
    }[][] = Array.from({ length: N }, () => []);

    // Build N synthetic exchanges, identifiable by body.
    const exchanges: Exchange[] = Array.from({ length: N }, (_, i) => ({
      id: `ex-${i}`,
      body: `payload-${i}`,
      headers: {} as Record<string, unknown>,
      logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    })) as unknown as Exchange[];

    await Promise.all(
      exchanges.map((ex, i) => wrapper.execute(ex, [], outerQueues[i]!)),
    );

    // Every outer queue should contain exactly the originating
    // exchange's child. If the per-execution buffer leaked, one of
    // these would be wrong or zero / two.
    for (let i = 0; i < N; i++) {
      const queue = outerQueues[i]!;
      expect(queue).toHaveLength(1);
      expect(queue[0]!.exchange.body).toBe(`payload-${i}`);
    }
  });

  /**
   * @case Chained-routes: `.error()` between routes stages route-scope for the next route
   * @preconditions craft().id(a).from(...).to(...).id(b).error(h).from(...) - error follows id but precedes from
   * @expectedResult When route b throws, h runs (route-scope catch-all), not a step-scope wrapper
   */
  test("chained-route .error() after .id() stages route-scope for the next route", async () => {
    const sink = spy();
    const handlerB = vi.fn(() => ({ caughtAtRouteB: true }));
    t = await testContext()
      .routes(
        craft()
          .id("a")
          .from(simple("ok-a"))
          .to(spy())
          .id("b")
          .error(handlerB)
          .from(simple("ok-b"))
          .transform(() => {
            throw new Error("b-failure");
          })
          .to(sink),
      )
      .build();

    await t.test();
    expect(handlerB).toHaveBeenCalledTimes(1);
    // Route-scope: pipeline halts after handler. Sink not reached.
    expect(sink.received).toHaveLength(0);
  });

  /**
   * @case Wrapping `aggregate` is rejected at builder time
   * @preconditions craft().error(h).aggregate(...) - aggregator can't observe siblings inside a wrapper
   * @expectedResult RC5003 thrown synchronously at construction; no route runs
   */
  test("wrapping aggregate throws at builder time", async () => {
    expect(() => {
      // Build the chain as `unknown` so we don't fight the
      // aggregator's generic inference for code that never runs;
      // we only want to assert the construction-time throw.
      const builder = craft()
        .id("wrap-agg")
        .from(simple([1, 2]))
        .split()
        .error(() => 0) as unknown as { aggregate: (fn: unknown) => unknown };
      (
        builder.aggregate(() => undefined) as unknown as {
          build: () => unknown;
        }
      ).build();
    }).toThrow(/cannot wrap.*aggregate|wrap.*split/i);
  });

  /**
   * @case Wrapping `split` is rejected at builder time
   * @preconditions craft().error(h).split(...) - split's children are emitted synchronously and recovery would truncate
   * @expectedResult RC5003 thrown synchronously at construction
   */
  test("wrapping split throws at builder time", async () => {
    expect(() => {
      craft()
        .id("wrap-split")
        .from(simple([1, 2, 3]))
        .error(() => 0)
        .split()
        .to(spy())
        .build();
    }).toThrow(/cannot wrap.*split/i);
  });

  /**
   * @case Wrapping a step that drops the exchange preserves the drop
   * @preconditions Wrapper around a filter that rejects every input; sink after the wrapper
   * @expectedResult Sink never receives the dropped exchange; routecraft.dropped flows through
   */
  test("wrapped filter that rejects keeps the drop (no resurrection)", async () => {
    const sink = spy();
    t = await testContext()
      .routes(
        craft()
          .id("wrap-filter-drop")
          .from(simple("input"))
          .error(() => "should-not-recover")
          .filter(() => false)
          .to(sink),
      )
      .build();

    await t.test();
    // Filter rejected the exchange. The wrapper must not re-inject it.
    expect(sink.received).toHaveLength(0);
  });

  /**
   * @case Wrapping a `skipStepEvents = true` step does not duplicate step events
   * @preconditions Wrapper around `tap()` (which has skipStepEvents = true) with a subscriber
   * @expectedResult Exactly one step:started for the tap operation, not two
   */
  test("wrapping a skipStepEvents step does not double-emit lifecycle events", async () => {
    const tapSink = spy();
    const sink = spy();
    const startedEvents: unknown[] = [];
    t = await testContext()
      .routes(
        craft()
          .id("no-double-events")
          .from(simple("input"))
          .error(() => "fallback")
          .tap(tapSink)
          .to(sink),
      )
      .build();

    t.ctx.on(
      "route:no-double-events:step:started" as never,
      ({ details }: { details: unknown }) => {
        const d = details as { operation?: string };
        if (d.operation === "tap") startedEvents.push(details);
      },
    );

    await t.test();
    expect(startedEvents).toHaveLength(1);
  });

  /**
   * @case Stacked wrapper emits step:failed when its inner runInner throws
   * @preconditions Outer wrapper recovers; inner wrapper's runInner throws
   * @expectedResult Inner wrapper emits step:started + step:failed; no orphan started without a closing event
   */
  test("stacked wrapper emits step:failed on cascade for balanced events", async () => {
    const events: string[] = [];
    // Custom outer wrapper that recovers the inner failure.
    class RecoveringOuter extends WrapperStep {
      protected override async runInner(
        exchange: Exchange,
        innerQueue: { exchange: Exchange; steps: Step<Adapter>[] }[],
      ): Promise<"ok" | "recovered"> {
        try {
          await this.inner.execute(exchange, [], innerQueue);
          return "ok";
        } catch {
          // Swallow inner's throw so the test asserts the inner's step events.
          (exchange as { body?: unknown }).body = "outer-recovered";
          innerQueue.length = 0;
          return "recovered";
        }
      }
    }
    // Inner wrapper that always throws (forces the cascade).
    class ThrowingInner extends WrapperStep {
      protected override async runInner(): Promise<"ok"> {
        throw new Error("inner-failed");
      }
    }

    const sink = spy();
    type WrapBuilder = {
      pendingStepWrappers: Array<(s: Step<Adapter>) => Step<Adapter>>;
    };
    const builder = craft().id("balanced-events").from(simple("hi"));
    // Stage wrappers so the NEXT step gets wrapped. We then add a
    // transform (which becomes the wrapped inner) and an unwrapped
    // `to(sink)` after, so the recovered exchange flows past the
    // wrapper and reaches the sink.
    (builder as unknown as WrapBuilder).pendingStepWrappers.push(
      (inner) => new RecoveringOuter(inner),
    );
    (builder as unknown as WrapBuilder).pendingStepWrappers.push(
      (inner) => new ThrowingInner(inner),
    );

    t = await testContext()
      .routes(builder.transform((b) => `pre-${b as string}`).to(sink))
      .build();
    t.ctx.on(
      "route:balanced-events:step:started" as never,
      ({ details }: { details: { operation: string } }) => {
        events.push(`started:${details.operation}`);
      },
    );
    t.ctx.on(
      "route:balanced-events:step:failed" as never,
      ({ details }: { details: { operation: string } }) => {
        events.push(`failed:${details.operation}`);
      },
    );
    t.ctx.on(
      "route:balanced-events:step:completed" as never,
      ({ details }: { details: { operation: string } }) => {
        events.push(`completed:${details.operation}`);
      },
    );

    await t.test();

    // The inner wrapper (whose inner is the transform step) emits
    // started and then failed when its runInner throws. The outer
    // wrapper does NOT emit started/completed because its inner is a
    // wrapper (skipStepEvents = true), so events are balanced and not
    // duplicated. The unwrapped to(sink) runs after recovery.
    expect(events).toContain("started:transform");
    expect(events).toContain("failed:transform");
    expect(sink.received).toHaveLength(1);
    expect(sink.received[0].body).toBe("outer-recovered");
  });

  /**
   * @case Staged wrapper that's never consumed before .id() throws
   * @preconditions craft().id(a).from(x).to(y).error(h).id(b)... - wrapper staged but no step follows
   * @expectedResult RC2001 thrown at .id() so the leak surfaces at build time
   */
  test("wrapper staged but never consumed throws at next .id()", () => {
    expect(() => {
      craft()
        .id("a")
        .from(simple("x"))
        .to(spy())
        .error(() => "leaked")
        .id("b");
    }).toThrow(/wrapper.*staged|never consumed|orphan/i);
  });

  /**
   * @case Staged wrapper that's never consumed before .from() throws
   * @preconditions Chained route shortcut (no .id() between routes); wrapper leaked from first route
   * @expectedResult RC2001 thrown at .from()
   */
  test("wrapper staged but never consumed throws at next .from()", () => {
    expect(() => {
      craft()
        .id("a")
        .from(simple("x"))
        .to(spy())
        .error(() => "leaked")
        .from(simple("y"));
    }).toThrow(/wrapper.*staged|never consumed|orphan/i);
  });

  /**
   * @case Staged wrapper that's never consumed before .build() throws
   * @preconditions craft().id(a).from(x).to(y).error(h) - last call is the wrapper, no step after
   * @expectedResult RC2001 thrown at .build()
   */
  test("wrapper staged but never consumed throws at .build()", () => {
    expect(() => {
      craft()
        .id("a")
        .from(simple("x"))
        .to(spy())
        .error(() => "leaked")
        .build();
    }).toThrow(/wrapper.*staged|never consumed|orphan/i);
  });

  /**
   * @case Step-scope handler receives a normalised RoutecraftError
   * @preconditions Inner throws a plain Error; handler captures the error it receives
   * @expectedResult Handler receives a RoutecraftError (rc/meta), not the raw Error
   */
  test("step-scope handler receives a normalised RoutecraftError", async () => {
    let captured: unknown;
    const sink = spy();
    t = await testContext()
      .routes(
        craft()
          .id("normalised-error")
          .from(simple("input"))
          .error((err) => {
            captured = err;
            return "ok";
          })
          .transform(() => {
            throw new Error("raw-throw");
          })
          .to(sink),
      )
      .build();

    await t.test();
    expect(captured).toBeDefined();
    const c = captured as { rc?: string; meta?: { message?: string } };
    expect(c.rc).toBe("RC5001");
    expect(c.meta?.message).toMatch(/raw-throw/);
  });

  /**
   * @case Wrapper-emitted step events carry the adapter label
   * @preconditions Subscriber on step:started for a wrapped to() step
   * @expectedResult The emitted detail object includes an `adapter` field
   */
  test("wrapper events carry adapter metadata", async () => {
    const adapters: unknown[] = [];
    const sink = spy();
    t = await testContext()
      .routes(
        craft()
          .id("adapter-meta")
          .from(simple("input"))
          .error(() => "fallback")
          .transform((b) => `t-${b as string}`)
          .to(sink),
      )
      .build();

    t.ctx.on(
      "route:adapter-meta:step:started" as never,
      ({ details }: { details: { operation: string; adapter?: string } }) => {
        if (details.operation === "transform") adapters.push(details.adapter);
      },
    );

    await t.test();
    expect(adapters).toHaveLength(1);
    expect(adapters[0]).toBeDefined();
  });

  /**
   * @case Wrapper exposes the inner step's identity
   * @preconditions Construct an ErrorWrapperStep around a known inner step
   * @expectedResult operation/adapter/label fields delegate to the inner step
   */
  test("wrapper delegates operation/adapter/label to its inner step", () => {
    const handler = vi.fn();
    const innerSpy: Step<Adapter> = {
      operation: "transform" as Step<Adapter>["operation"],
      adapter: { kind: "fake" } as unknown as Adapter,
      label: "fake-step",
      async execute(): Promise<void> {
        // never called in this test
      },
    };
    const wrapped = new ErrorWrapperStep(innerSpy, handler);
    expect(wrapped.operation).toBe(innerSpy.operation);
    expect(wrapped.adapter).toBe(innerSpy.adapter);
    expect(wrapped.label).toBe("fake-step");
    expect(wrapped.skipStepEvents).toBe(true);
  });
});
