import { afterEach, describe, expect, mock, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import {
  craft,
  DefaultExchange,
  direct,
  ErrorWrapperStep,
  simple,
  WrapperStep,
  type Step,
  type Adapter,
  type Exchange,
  type StepContext,
  type StepOutcome,
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
    const handler = mock(() => ({ shouldNotRun: true }));
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
        ctx: StepContext,
      ): Promise<StepOutcome> {
        calls.push("outer-before");
        const outcome = await this.inner.execute(exchange, ctx);
        calls.push("outer-after");
        return outcome;
      }
    }
    class TraceWrapperInner extends WrapperStep {
      protected override async runInner(
        exchange: Exchange,
        ctx: StepContext,
      ): Promise<StepOutcome> {
        calls.push("inner-before");
        const outcome = await this.inner.execute(exchange, ctx);
        calls.push("inner-after");
        return outcome;
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
    const routeHandler = mock(() => ({ caughtAtRoute: true }));
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
    const routeHandler = mock(() => ({ shouldNotRun: true }));
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
      "route:error-handler:invoked" as never,
      ({ details }: { details: unknown }) => {
        events.push({ name: "invoked", details });
      },
    );
    t.ctx.on(
      "route:error-handler:recovered" as never,
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
   * @case Concurrent execute() calls on one wrapper instance return independent outcomes
   * @preconditions Single ErrorWrapperStep instance; fire 10 concurrent execute() calls with overlapping inner work
   * @expectedResult Each call's outcome carries the originating exchange; no cross-talk
   *   (with the outcome contract there is no shared buffer by construction,
   *   so this guards against any future reintroduction of per-instance state)
   */
  test("concurrent execute() calls share no per-execution state", async () => {
    // Hand-build a wrapper unit test (no testContext) to avoid the
    // start/stop race that would come from calling `t.test()` in
    // parallel on a single TestContext.

    // Fake inner step that yields the event loop then returns a
    // continue outcome whose body identifies the originating exchange.
    const innerStep: Step<Adapter> = {
      operation: "transform" as Step<Adapter>["operation"],
      adapter: { adapterId: "fake.inner" } as unknown as Adapter,
      async execute(exchange: Exchange): Promise<StepOutcome> {
        // Yield so multiple execute() invocations interleave.
        await new Promise((r) => setTimeout(r, 1));
        return { kind: "continue", exchange };
      },
    };
    const wrapper = new ErrorWrapperStep(innerStep, () => "unused");

    const N = 10;
    const stepContext: StepContext = {
      takePending: () => [],
      runPaths: async () => {},
      runPath: async () => ({ failed: false, dropped: false }),
    };

    // Build N synthetic exchanges, identifiable by body.
    const exchanges: Exchange[] = Array.from({ length: N }, (_, i) => ({
      id: `ex-${i}`,
      body: `payload-${i}`,
      headers: {} as Record<string, unknown>,
      logger: { warn: mock(), error: mock(), debug: mock() } as never,
    })) as unknown as Exchange[];

    const outcomes = await Promise.all(
      exchanges.map((ex) => wrapper.execute(ex, stepContext)),
    );

    // Every outcome should carry exactly the originating exchange.
    for (let i = 0; i < N; i++) {
      const outcome = outcomes[i]!;
      expect(outcome.kind).toBe("continue");
      if (outcome.kind === "continue") {
        expect(outcome.exchange.body).toBe(`payload-${i}`);
      }
    }
  });

  /**
   * @case Chained-routes: `.error()` between routes stages route-scope for the next route
   * @preconditions craft().id(a).from(...).to(...).id(b).error(h).from(...) - error follows id but precedes from
   * @expectedResult When route b throws, h runs (route-scope catch-all), not a step-scope wrapper
   */
  test("chained-route .error() after .id() stages route-scope for the next route", async () => {
    const sink = spy();
    const handlerB = mock(() => ({ caughtAtRouteB: true }));
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
      "route:step:started" as never,
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
        ctx: StepContext,
      ): Promise<StepOutcome> {
        try {
          return await this.inner.execute(exchange, ctx);
        } catch {
          // Swallow inner's throw so the test asserts the inner's step
          // events, and substitute a recovered outcome (exchanges are
          // frozen; rewrap to produce a derived instance with the new
          // body).
          return {
            kind: "continue",
            exchange: DefaultExchange.rewrap(exchange, {
              body: "outer-recovered",
            }),
          };
        }
      }
    }
    // Inner wrapper that always throws (forces the cascade).
    class ThrowingInner extends WrapperStep {
      protected override async runInner(): Promise<StepOutcome> {
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
      "route:step:started" as never,
      ({ details }: { details: { operation: string } }) => {
        events.push(`started:${details.operation}`);
      },
    );
    t.ctx.on(
      "route:step:failed" as never,
      ({ details }: { details: { operation: string } }) => {
        events.push(`failed:${details.operation}`);
      },
    );
    t.ctx.on(
      "route:step:completed" as never,
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
      "route:step:started" as never,
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
    const handler = mock();
    const innerSpy: Step<Adapter> = {
      operation: "transform" as Step<Adapter>["operation"],
      adapter: { kind: "fake" } as unknown as Adapter,
      label: "fake-step",
      async execute(exchange: Exchange): Promise<StepOutcome> {
        // never called in this test
        return { kind: "continue", exchange };
      },
    };
    const wrapped = new ErrorWrapperStep(innerSpy, handler);
    expect(wrapped.operation).toBe(innerSpy.operation);
    expect(wrapped.adapter).toBe(innerSpy.adapter);
    expect(wrapped.label).toBe("fake-step");
    expect(wrapped.skipStepEvents).toBe(true);
  });

  /**
   * @case A step returns the reserved `suspend` outcome before suspend/resume is implemented
   * @preconditions Custom wrapper step returns { kind: "suspend", exchange } from execute
   * @expectedResult Executor rejects it with RC5032 (fails loud) instead of silently dropping the exchange; the sink is never reached
   */
  test("suspend outcome is rejected with RC5032 until the feature lands", async () => {
    const suspendingStep = (inner: Step<Adapter>): Step<Adapter> => ({
      operation: inner.operation,
      adapter: inner.adapter,
      label: "suspending-step",
      // Forward-compat stub: the kind is declared on the union but no
      // built-in step produces it yet, so the executor must reject it.
      async execute(exchange: Exchange): Promise<StepOutcome> {
        return { kind: "suspend", exchange };
      },
    });

    const sink = spy();
    type WrapBuilder = {
      pendingStepWrappers: Array<(s: Step<Adapter>) => Step<Adapter>>;
    };
    const builder = craft().id("suspend-rejected").from(simple("hi"));
    (builder as unknown as WrapBuilder).pendingStepWrappers.push(
      suspendingStep,
    );

    t = await testContext().routes(builder.to(sink)).build();
    await t.test();

    expect(sink.received).toHaveLength(0);
    expect(t.errors.some((e) => e.rc === "RC5032")).toBe(true);
  });
});
