import { afterEach, describe, expect, test } from "bun:test";
import { bootServer, testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  direct,
  isInternalEndpoint,
  noop,
  opsPlugin,
  registerCapability,
  registerInternalEndpoint,
  type OpsPage,
  type OpsRouteSummary,
} from "../src/index.ts";
import { CraftContext } from "../src/context.ts";
import { DirectSourceAdapter } from "../src/adapters/direct/source.ts";
import { rcCodeOf } from "../src/brand.ts";

/**
 * A registration on the capability registry lives exactly as long as the
 * thing that answers it.
 *
 * The registry is what the agent tool surface is derived from and what the
 * ops listing calls `dispatchable`, so an entry that outlives its route is
 * an endpoint offered to a model and reported to an operator that nothing
 * behind it will answer. The three cases here are the three ways an entry
 * used to outlive its route: a route that stops, a subscription aborted
 * before it ever subscribed, and a disposer arriving after something else
 * has taken the name.
 */
describe("capability registration lifecycle", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /** The route on this context with the given id, or a failure naming it. */
  function routeOf(context: TestContext, id: string) {
    const route = context.ctx.getRoutes().find((r) => r.definition.id === id);
    if (route === undefined) throw new Error(`no route "${id}" is registered`);
    return route;
  }

  /**
   * @case A stopped route stops being a capability
   * @preconditions A running `direct()` route, stopped through `route.stop()`
   * @expectedResult The endpoint leaves `ctx.capabilities()`. The registry is the agent tool surface, so an entry that outlives its route offers a model a tool whose dispatch can only fail
   */
  test("removes the capability when the route stops", async () => {
    t = await testContext()
      .routes([craft().id("greet").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();
    const listed = (): boolean =>
      t!.ctx.capabilities().some((c) => c.endpoint === "greet");

    expect(listed()).toBe(true);

    await routeOf(t, "greet").stop();

    expect(listed()).toBe(false);
  });

  /**
   * @case A stopped internal route stops being marked internal
   * @preconditions A running `direct({ internal: true })` route, then stopped
   * @expectedResult The marker goes with the route. It is what the external doors refuse by name, and a marker for a route that no longer exists refuses on behalf of nothing
   */
  test("clears the internal marker when the route stops", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("subroutine")
          .from(direct({ internal: true }))
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    expect(isInternalEndpoint(t.ctx, "subroutine")).toBe(true);

    await routeOf(t, "subroutine").stop();

    expect(isInternalEndpoint(t.ctx, "subroutine")).toBe(false);
  });

  /**
   * @case The ops listing calls a stopped route undispatchable and still lists it
   * @preconditions An instance with the introspection and dispatch tiers open and one `direct()` route, stopped after boot
   * @expectedResult The route is still listed, with `dispatchable: false`, and a dispatch is refused RC5060 naming the route as not running rather than advising a `.from(direct())` it already has. `enabled` is computed from the route's own predicate and is unaffected, which is why removing the registry entry does not cost the listing a state it needs
   */
  test("reports a stopped route as no longer dispatchable", async () => {
    const booted = await bootServer((builder) =>
      builder
        .with({
          servers: { default: { port: 0, host: "127.0.0.1" } },
          plugins: [
            opsPlugin({ tiers: { introspection: true, dispatch: true } }),
          ],
        })
        .routes([craft().id("greet").from(direct()).to(noop())]),
    );
    t = booted.ctx;
    const base = `http://127.0.0.1:${String(booted.port)}`;
    const summary = async (): Promise<OpsRouteSummary | undefined> => {
      const response = await fetch(`${base}/ops/routes?id=greet`);
      const page = (await response.json()) as OpsPage<OpsRouteSummary>;
      return page.items[0];
    };

    expect(await summary()).toMatchObject({
      id: "greet",
      dispatchable: true,
      enabled: true,
    });

    await routeOf(t, "greet").stop();

    expect(await summary()).toMatchObject({
      id: "greet",
      dispatchable: false,
      enabled: true,
    });
    const dispatch = await fetch(`${base}/ops/routes/greet/exchanges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const refusal = (await dispatch.json()) as { code?: string };
    expect(dispatch.status).toBe(409);
    expect(refusal.code).toBe("RC5060");
  });

  /**
   * @case A subscription that is already aborted registers nothing
   * @preconditions `DirectSourceAdapter.subscribe()` called with an aborted signal, both as a capability and as an internal endpoint
   * @expectedResult Neither registry gains an entry. The adapter returns before it subscribes a handler, so an entry written ahead of that check would describe a door that never opened and would have no unsubscribe to clean it up
   */
  test("registers nothing for a subscription that is already aborted", async () => {
    for (const internal of [false, true]) {
      const context = new CraftContext({});
      const controller = new AbortController();
      controller.abort();

      await new DirectSourceAdapter({ internal }).subscribe({
        context,
        signal: controller.signal,
        meta: { routeId: "greet" },
        emit: async () => undefined,
        ready: () => undefined,
      } as never);

      expect(context.capabilities()).toEqual([]);
      expect(isInternalEndpoint(context, "greet")).toBe(false);
    }
  });

  /**
   * @case A late disposer leaves a replacement alone
   * @preconditions One endpoint registered, then re-registered by a second owner; the first owner's disposer runs afterwards
   * @expectedResult The second registration survives. This is the remotes handoff: `route:stopped` reaches the remotes plugin before the direct source's own abort listener, so the plugin has already advertised the remote route by the time the local disposer runs, and an unconditional delete would erase the endpoint the remote now owns
   */
  test("a disposer whose entry was replaced removes nothing", () => {
    const context = new CraftContext({});

    const disposeLocal = registerCapability(context, { endpoint: "hello" });
    registerCapability(context, { endpoint: "hello", remote: "lab" });
    disposeLocal();

    expect(context.capabilities()).toMatchObject([
      { endpoint: "hello", remote: "lab" },
    ]);
  });

  /**
   * @case The internal marker follows the same ownership rule
   * @preconditions One endpoint marked internal twice, then the first registration's disposer run
   * @expectedResult The marker stands. A set of names could not tell the two registrations apart, which is why the registry holds an identity token per registration
   */
  test("an internal disposer whose marker was replaced removes nothing", () => {
    const context = new CraftContext({});

    const disposeFirst = registerInternalEndpoint(context, "subroutine");
    registerInternalEndpoint(context, "subroutine");
    disposeFirst();

    expect(isInternalEndpoint(context, "subroutine")).toBe(true);
  });

  /**
   * @case A dispatch to a stopped route says the route stopped
   * @preconditions A running direct route, stopped, then dispatched to through the client
   * @expectedResult RC5004. The registry no longer offers the endpoint, and a caller holding a reference from before the stop still gets the channel's own refusal rather than silence
   */
  test("a dispatch to a stopped route is refused", async () => {
    t = await testContext()
      .routes([craft().id("greet").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();
    await routeOf(t, "greet").stop();

    const failure = await t.client.sendDirect("greet", {}).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(rcCodeOf(failure)).toBe("RC5004");
  });
});
