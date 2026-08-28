import { afterEach, describe, expect, test } from "bun:test";
import { craft, direct, noop, simple } from "../src/index.ts";
import { spy, testContext, type TestContext } from "@routecraft/testing";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Route enablement: whether a route runs at all.
 *
 * The state a capability without its credentials never had. Before this, such
 * a route either registered and failed when something called it, or was
 * commented out by hand, and a missing route looked exactly like a
 * deliberately-off one though only the first is an incident.
 *
 * The context owns the state, ops reports it, and the tool surface follows
 * it. That last part is the point: the agent tool list is derived from what
 * the context has enabled, so "the agent cannot use this until I supply
 * credentials" holds by construction rather than by the model behaving well.
 */
describe("route enablement", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A route whose predicate returns a reason string is registered but never started
   * @preconditions One route with a false predicate and one without any predicate, in the same context
   * @expectedResult Both routes are registered; only the enabled one produced work, and the disabled one reports its reason
   */
  test("registers a disabled route without starting it", async () => {
    const off = spy();
    const on = spy();

    t = await testContext()
      .routes([
        craft()
          .id("needs-credentials")
          .enabled(() => "MAIL_USER and MAIL_APP_PASSWORD are not set")
          .from(simple("inbound"))
          .to(off),
        craft().id("always-on").from(simple("hello")).to(on),
      ])
      .build();
    await t.startAndWaitReady();

    // Registered and known: a route that is off must still be findable, or
    // an operator cannot tell it apart from one that was never deployed.
    expect(t.ctx.getRouteById("needs-credentials")).toBeDefined();
    expect(t.ctx.isRouteEnabled("needs-credentials")).toBe(false);
    expect(t.ctx.isRouteEnabled("always-on")).toBe(true);
    expect(off.received).toHaveLength(0);
    expect(on.received).toHaveLength(1);
    expect([...t.ctx.disabledRoutes()]).toEqual([
      ["needs-credentials", "MAIL_USER and MAIL_APP_PASSWORD are not set"],
    ]);
  });

  /**
   * @case A predicate returning true leaves the route running exactly as an undeclared one
   * @preconditions A route whose predicate returns true
   * @expectedResult The route starts, produces its exchange, and reports enabled with no reason
   */
  test("starts a route whose predicate passes", async () => {
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("configured")
          .enabled(() => true)
          .from(simple("payload"))
          .to(sink),
      )
      .build();
    await t.startAndWaitReady();

    expect(t.ctx.isRouteEnabled("configured")).toBe(true);
    expect(sink.received).toHaveLength(1);
    expect(t.ctx.disabledRoutes().size).toBe(0);
  });

  /**
   * @case A disabled route is absent from the agent tool surface
   * @preconditions Two discoverable direct routes in one context, one of them disabled
   * @expectedResult capabilities() lists only the enabled endpoint, so the disabled one is never offered as a tool
   */
  test("withholds a disabled route from the capability surface", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("send-invoice")
          .description("Send an invoice")
          .enabled(() => "BILLING_TOKEN is not set")
          .from(direct())
          .to(noop()),
        craft()
          .id("lookup-user")
          .description("Look up a user")
          .from(direct())
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const endpoints = t.ctx.capabilities().map((c) => c.endpoint);
    expect(endpoints).toEqual(["lookup-user"]);
  });

  /**
   * @case A predicate that throws disables its route and leaves the boot intact
   * @preconditions One route whose predicate throws, alongside a healthy route
   * @expectedResult start() resolves, the throwing route is disabled with the error message as its reason, and the healthy route ran
   */
  test("disables a route whose predicate throws without failing the boot", async () => {
    const healthy = spy();

    t = await testContext()
      .routes([
        craft()
          .id("explodes")
          .enabled(() => {
            throw new Error("vault unreachable");
          })
          .from(simple("x"))
          .to(noop()),
        craft().id("healthy").from(simple("y")).to(healthy),
      ])
      .build();

    // The assertion is that this resolves at all: a missing credential is a
    // configuration state, and a configuration state must never take the
    // process down.
    await t.startAndWaitReady();

    expect(t.ctx.isRouteEnabled("explodes")).toBe(false);
    expect(t.ctx.disabledRoutes().get("explodes")).toContain(
      "vault unreachable",
    );
    expect(healthy.received).toHaveLength(1);
  });

  /**
   * @case An async predicate is awaited before the route is started
   * @preconditions A predicate returning a promise that resolves to a reason string after a tick
   * @expectedResult The route is disabled, so the boot waited for the verdict rather than racing it
   */
  test("awaits an async predicate", async () => {
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("async-gate")
          .enabled(async () => {
            await sleep(10);
            return "the remote flag service says off";
          })
          .from(simple("x"))
          .to(sink),
      )
      .build();
    await t.startAndWaitReady();

    expect(t.ctx.isRouteEnabled("async-gate")).toBe(false);
    expect(sink.received).toHaveLength(0);
  });

  /**
   * @case A bare false disables the route with a generic reason
   * @preconditions A predicate returning false rather than a string
   * @expectedResult The route is disabled and carries the default reason, so ops still has something to print
   */
  test("disables on a bare false with a default reason", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("plain-false")
          .enabled(() => false)
          .from(simple("x"))
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();

    expect(t.ctx.isRouteEnabled("plain-false")).toBe(false);
    expect(t.ctx.disabledRoutes().get("plain-false")).toBe(
      "the route's enabled() predicate returned false",
    );
  });

  /**
   * @case Re-evaluating on demand brings up a route whose predicate now passes
   * @preconditions A route disabled at boot by a flag the test flips afterwards
   * @expectedResult reevaluateEnablement reports it enabled, and the route starts and serves without a process restart
   */
  test("starts a re-enabled route on demand", async () => {
    let credentialPresent = false;
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("late-credential")
          .enabled(() => (credentialPresent ? true : "TOKEN is not set"))
          .from(direct())
          .to(sink),
      )
      .build();
    await t.startAndWaitReady();
    expect(t.ctx.isRouteEnabled("late-credential")).toBe(false);

    // The operator loop the deferred /ops endpoint automates: set the
    // secret, ask for a re-check, and the capability comes up in place.
    credentialPresent = true;
    const states = await t.ctx.reevaluateEnablement("late-credential");

    expect(states.get("late-credential")).toEqual({ enabled: true });
    expect(t.ctx.isRouteEnabled("late-credential")).toBe(true);
    await t.client.sendDirect("late-credential", "now-works");
    expect(sink.received).toHaveLength(1);
  });

  /**
   * @case A re-enabled route is offered as an agent tool again
   * @preconditions A discoverable direct route disabled at boot, then re-enabled on demand
   * @expectedResult The endpoint is absent from capabilities() while disabled and present after
   */
  test("returns a re-enabled route to the capability surface", async () => {
    let ready = false;

    t = await testContext()
      .routes(
        craft()
          .id("gated-tool")
          .description("Gated")
          .enabled(() => (ready ? true : "not yet"))
          .from(direct())
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();
    expect(t.ctx.capabilities()).toHaveLength(0);

    ready = true;
    await t.ctx.reevaluateEnablement("gated-tool");

    expect(t.ctx.capabilities().map((c) => c.endpoint)).toEqual(["gated-tool"]);
  });

  /**
   * @case Disabling a running route drains in-flight work rather than cancelling it
   * @preconditions A running route holding an exchange mid-step when its predicate flips to false
   * @expectedResult The in-flight step completes and reaches its destination, and the route stops intaking
   */
  test("drains in-flight work when a running route is disabled", async () => {
    let enabled = true;
    let completed = false;
    const sink = spy();
    const inStep = Promise.withResolvers<void>();

    t = await testContext()
      .with({ shutdown: { timeout: 5_000 } })
      .routes(
        craft()
          .id("draining")
          .enabled(() => (enabled ? true : "switched off"))
          .from(direct())
          .transform(async (body: unknown) => {
            inStep.resolve();
            await sleep(120);
            completed = true;
            return body;
          })
          .to(sink),
      )
      .build();
    await t.startAndWaitReady();

    const dispatch = t.client.sendDirect("draining", "payload");
    await inStep.promise;

    // Flip while that exchange is genuinely mid-step: a flag flip must never
    // be a data-loss event, so this is a drain and not a cancellation.
    enabled = false;
    await t.ctx.reevaluateEnablement("draining");
    await dispatch;

    expect(completed).toBe(true);
    expect(sink.received).toHaveLength(1);
    expect(t.ctx.isRouteEnabled("draining")).toBe(false);
    // Intake is closed, which is the other half of the two-signal contract.
    expect(t.ctx.getRouteById("draining")?.intakeSignal.aborted).toBe(true);
  });

  /**
   * @case A disable that outlives the grace period abandons what is left
   * @preconditions A step that never settles, and a short shutdown.timeout
   * @expectedResult The route's execution signal fires, so the forced stage ran after the drain deadline
   */
  test("forces execution abort once the grace period elapses", async () => {
    let enabled = true;
    let forced = false;
    const inStep = Promise.withResolvers<void>();

    t = await testContext()
      .with({ shutdown: { timeout: 200 } })
      .routes(
        craft()
          .id("wedged")
          .enabled(() => (enabled ? true : "switched off"))
          .from(direct())
          .transform(() => {
            inStep.resolve();
            return new Promise(() => {
              // Never settles: this is what the forced stage exists for.
            });
          })
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();

    t.ctx.getRouteById("wedged")?.signal.addEventListener("abort", () => {
      forced = true;
    });

    void t.client.sendDirect("wedged", "payload").catch(() => undefined);
    await inStep.promise;

    enabled = false;
    await t.ctx.reevaluateEnablement("wedged");

    expect(forced).toBe(true);
  });

  /**
   * @case An unchanged verdict on re-evaluation is not announced
   * @preconditions A stable predicate re-evaluated twice after boot
   * @expectedResult route:enablement:changed fires once (the boot verdict) and not again
   */
  test("announces only genuine transitions", async () => {
    const changes: Array<{ routeId: string; enabled: boolean }> = [];

    t = await testContext()
      .routes(
        craft()
          .id("stable")
          .enabled(() => "always off")
          .from(direct())
          .to(noop()),
      )
      .build();
    t.ctx.on("route:enablement:changed", ({ details }) => {
      changes.push({ routeId: details.routeId, enabled: details.enabled });
    });
    await t.startAndWaitReady();

    const afterBoot = changes.length;
    await t.ctx.reevaluateEnablement("stable");
    await t.ctx.reevaluateEnablement("stable");

    // A five-minute cadence over a stable predicate must be silent, or the
    // one event that matters is lost in the heartbeat.
    expect(changes.length).toBe(afterBoot);
  });

  /**
   * @case Re-evaluating with no route id covers every declaring route
   * @preconditions Two declaring routes and one that declares nothing
   * @expectedResult Both declaring routes appear in the result and the undeclared one does not
   */
  test("re-evaluates every declaring route when given no id", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("first")
          .enabled(() => "off")
          .from(direct())
          .to(noop()),
        craft()
          .id("second")
          .enabled(() => true)
          .from(direct())
          .to(noop()),
        craft().id("undeclared").from(direct()).to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const states = await t.ctx.reevaluateEnablement();

    expect([...states.keys()].sort()).toEqual(["first", "second"]);
    expect(states.get("first")).toEqual({
      enabled: false,
      reason: "off",
    });
    expect(states.get("second")).toEqual({ enabled: true });
  });

  /**
   * @case An interval cadence re-evaluates without anything asking it to
   * @preconditions A route disabled at boot with refresh: 30, and the flag flipped afterwards
   * @expectedResult The route becomes enabled on its own within a few cadence periods
   */
  test("re-evaluates on an interval refresh cadence", async () => {
    let ready = false;

    t = await testContext()
      .routes(
        craft()
          .id("polled")
          .enabled(() => (ready ? true : "not yet"), { refresh: 30 })
          .from(direct())
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();
    expect(t.ctx.isRouteEnabled("polled")).toBe(false);

    ready = true;
    const deadline = Date.now() + 2_000;
    while (!t.ctx.isRouteEnabled("polled") && Date.now() < deadline) {
      await sleep(10);
    }

    expect(t.ctx.isRouteEnabled("polled")).toBe(true);
  });

  /**
   * @case A malformed refresh cadence is refused while the route is built
   * @preconditions .enabled() given a refresh that is neither a cron expression nor a usable duration
   * @expectedResult Building throws RC5003, rather than leaving a dead timer to be discovered at boot
   */
  test("refuses a malformed refresh cadence at build time", () => {
    expect(() =>
      craft()
        .id("bad-cadence")
        .enabled(() => true, { refresh: "every-so-often" as unknown as 5 }),
    ).toThrow(/refresh/);
  });

  /**
   * @case .enabled() refuses a non-function predicate
   * @preconditions A JS caller passing a boolean where the predicate belongs
   * @expectedResult Building throws, instead of a truthy value silently enabling the route
   */
  test("refuses a predicate that is not a function", () => {
    expect(() =>
      craft()
        .id("not-a-function")
        .enabled(true as unknown as () => boolean),
    ).toThrow(/predicate function/);
  });

  /**
   * @case .enabled() may only be declared once per route
   * @preconditions Two .enabled() calls staged before the same .from()
   * @expectedResult The second call throws, so one route cannot carry two contradictory gates
   */
  test("refuses a second .enabled() on one route", () => {
    expect(() =>
      craft()
        .id("twice")
        .enabled(() => true)
        .enabled(() => false),
    ).toThrow(/only be called once/);
  });

  /**
   * @case A route declaring no predicate is never tracked as enablement state
   * @preconditions A plain route with no .enabled() call
   * @expectedResult isRouteEnabled reports true and the route holds no state entry, so the common case costs nothing
   */
  test("treats an undeclared route as enabled", async () => {
    const sink = spy();

    t = await testContext()
      .routes(craft().id("plain").from(simple("x")).to(sink))
      .build();
    await t.startAndWaitReady();

    expect(t.ctx.isRouteEnabled("plain")).toBe(true);
    expect(t.ctx.disabledRoutes().size).toBe(0);
    expect(sink.received).toHaveLength(1);
  });

  /**
   * @case An explicit refresh: "manual" behaves exactly like omitting refresh
   * @preconditions Two disabled routes, one omitting refresh and one passing "manual"
   * @expectedResult Both stay disabled with no cadence armed, and both still respond to an on-demand re-check
   */
  test("treats refresh: manual as the default cadence, said out loud", async () => {
    let ready = false;
    const predicate = (): boolean | string => (ready ? true : "not yet");

    t = await testContext()
      .routes([
        craft().id("implicit").enabled(predicate).from(direct()).to(noop()),
        craft()
          .id("explicit")
          .enabled(predicate, { refresh: "manual" })
          .from(direct())
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    expect(t.ctx.isRouteEnabled("implicit")).toBe(false);
    expect(t.ctx.isRouteEnabled("explicit")).toBe(false);

    // Nothing re-evaluates on its own for either of them.
    ready = true;
    await sleep(60);
    expect(t.ctx.isRouteEnabled("implicit")).toBe(false);
    expect(t.ctx.isRouteEnabled("explicit")).toBe(false);

    // Both still answer the on-demand control surface.
    await t.ctx.reevaluateEnablement();
    expect(t.ctx.isRouteEnabled("implicit")).toBe(true);
    expect(t.ctx.isRouteEnabled("explicit")).toBe(true);
  });

  /**
   * @case A computed cadence can fall back to "manual" without assembling the options object conditionally
   * @preconditions refresh given as `undefined ?? "manual"`, the shape a computed cadence produces
   * @expectedResult The route builds and is disabled, so the sentinel is accepted where a bare string would be refused
   */
  test("accepts manual as a computed cadence fallback", async () => {
    const configuredCadence: string | undefined = undefined;

    t = await testContext()
      .routes(
        craft()
          .id("computed")
          .enabled(() => "off", {
            refresh: (configuredCadence ?? "manual") as "manual",
          })
          .from(direct())
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();

    expect(t.ctx.isRouteEnabled("computed")).toBe(false);
  });
});
