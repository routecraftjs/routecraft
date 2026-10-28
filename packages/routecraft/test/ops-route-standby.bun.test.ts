import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  direct,
  noop,
  opsPlugin,
  type HealthReport,
} from "../src/index.ts";
import { HealthState } from "../src/plugins/ops/state.ts";

/**
 * A running route whose target is gone (`route:standby:changed`) is listed
 * `inactive` with the reason and never moves the aggregate.
 */
describe("routes on standby", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  async function start(): Promise<number> {
    t = await testContext()
      .with({
        servers: { default: { port: 0, host: "127.0.0.1" } },
        plugins: [opsPlugin({ health: { details: "always" } })],
      })
      .routes([craft().id("vendor-search").from(direct()).to(noop())])
      .build();
    let port: number | undefined;
    t.ctx.on("server:listening", ({ details }) => {
      port = details.port;
    });
    await t.startAndWaitReady();
    if (port === undefined) throw new Error("no server reported a port");
    return port;
  }

  async function health(
    port: number,
  ): Promise<{ status: number; body: HealthReport }> {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return { status: res.status, body: (await res.json()) as HealthReport };
  }

  /**
   * @case A standby route is reported inactive with its reason, and comes back to up
   * @preconditions A running route; route:standby:changed { standby: true, reason } is emitted, then { standby: false }
   * @expectedResult While on standby /health lists the route inactive with lifecycle "standby" and the reason, and answers 200; after, the route reads up and running
   */
  test("standby reads inactive with the reason, then up again", async () => {
    const port = await start();
    t!.ctx.emit("route:standby:changed", {
      routeId: "vendor-search",
      standby: true,
      reason: 'client "vendor" does not list tool "search"',
    });
    const on = await health(port);
    expect(on.status).toBe(200);
    expect(on.body.routes["vendor-search"]).toMatchObject({
      status: "inactive",
      details: {
        lifecycle: "standby",
        reason: 'client "vendor" does not list tool "search"',
      },
    });

    t!.ctx.emit("route:standby:changed", {
      routeId: "vendor-search",
      standby: false,
    });
    const off = await health(port);
    expect(off.body.routes["vendor-search"]).toMatchObject({
      status: "up",
      details: { lifecycle: "running" },
    });
    expect(off.body.routes["vendor-search"]?.details?.["reason"]).toBe(
      undefined,
    );
  });
});

describe("the health ledger and standby", () => {
  /**
   * @case A standby reported while a route is still starting survives the start
   * @preconditions setRouteStandby before routeStarted for the same route
   * @expectedResult After routeStarted the route reads inactive with the reason, rather than running
   */
  test("standby before the route started is applied once it starts", () => {
    const state = new HealthState({ now: () => 0 });
    state.contextStarted();
    state.setRouteStandby("r", "target gone");
    state.routeStarted("r");
    expect(state.routeComponentOf("r")).toMatchObject({
      status: "inactive",
      details: { lifecycle: "standby", reason: "target gone" },
    });
  });

  /**
   * @case Standby never overrides a truer disposition
   * @preconditions A route disabled by its predicate, then reported on standby
   * @expectedResult It stays disabled with the disabled reason
   */
  test("a disabled route stays disabled", () => {
    const state = new HealthState({ now: () => 0 });
    state.contextStarted();
    state.routeStarted("r");
    state.setRouteDisabled("r", "TOKEN is unset");
    state.setRouteStandby("r", "target gone");
    expect(state.routeComponentOf("r")).toMatchObject({
      status: "inactive",
      details: { lifecycle: "disabled", reason: "TOKEN is unset" },
    });
  });
});
