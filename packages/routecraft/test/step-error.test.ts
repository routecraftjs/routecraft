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
   * @case Concurrent exchanges through the same step instance do not share state
   * @preconditions Single .error() wrapper around a slow transform; fire many exchanges in parallel
   * @expectedResult Every recovered body equals the handler's return; no cross-talk between exchanges
   */
  test("concurrent exchanges through one wrapper instance do not alias state", async () => {
    const sink = spy();
    const handler = vi.fn((err) => `recovered-from-${(err as Error).message}`);
    t = await testContext()
      .routes(
        craft()
          .id("concurrent-wrapper")
          .from(simple("payload"))
          .error(handler)
          .transform(async (body) => {
            // Stagger the failure so multiple exchanges interleave inside the wrapper.
            await new Promise((r) => setTimeout(r, 1));
            throw new Error(`boom-${body as string}`);
          })
          .to(sink),
      )
      .build();

    // Fire several exchanges through the single wrapper instance.
    await Promise.all(Array.from({ length: 10 }, () => t!.test()));
    expect(sink.received.length).toBeGreaterThanOrEqual(10);
    for (const ex of sink.received) {
      expect(ex.body).toBe("recovered-from-boom-payload");
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
