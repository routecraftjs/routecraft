import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  defineIndicator,
  direct,
  noop,
  opsPlugin,
  type HealthReport,
  type OpsPluginOptions,
} from "../src/index.ts";
import { HealthState } from "../src/plugins/ops/state.ts";

/** Whatever the test harness accepts as a route list. */
type Routes = Parameters<ReturnType<typeof testContext>["routes"]>[0];

async function health(
  port: number,
): Promise<{ status: number; body: HealthReport }> {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  return { status: res.status, body: (await res.json()) as HealthReport };
}

/**
 * Disabled is not down: an indicator for a dependency nobody configured,
 * whether it says so itself or follows the probe route it is bound to,
 * reports `inactive` with the reason, never pages, and never goes stale.
 */
describe("indicators follow enablement", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /** Start a context with the ops mount serving details, and return its port. */
  async function start(
    options: OpsPluginOptions,
    routes: Routes,
  ): Promise<number> {
    t = await testContext()
      .with({
        servers: { default: { port: 0, host: "127.0.0.1" } },
        plugins: [opsPlugin({ health: { details: "always" }, ...options })],
      })
      .routes(routes)
      .build();
    let port: number | undefined;
    t.ctx.on("server:listening", ({ details }) => {
      port = details.port;
    });
    await t.startAndWaitReady();
    if (port === undefined) throw new Error("no server reported a port");
    return port;
  }

  /**
   * @case An indicator bound to a disabled probe route reports inactive with the route's reason, and never goes stale
   * @preconditions Probe route disabled at boot with reason "UPTIME_TOKEN is unset"; indicator bound to it with maxAge 50ms; the test waits past maxAge
   * @expectedResult The indicator is inactive with details.reason "UPTIME_TOKEN is unset", and the aggregate stays 200 where a stale indicator would page
   */
  test("a bound indicator follows its disabled route", async () => {
    const probe = defineIndicator({
      name: "uptime",
      maxAge: "50ms",
      route: "probe-uptime",
    });
    const port = await start({ indicators: [probe] }, [
      craft()
        .id("probe-uptime")
        .enabled(() => "UPTIME_TOKEN is unset", { refresh: "1h" })
        .from(direct())
        .to(noop()),
      craft().id("worker").from(direct()).to(noop()),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const report = await health(port);
    expect(report.body.indicators["uptime"]).toEqual({
      status: "inactive",
      domain: "deployment",
      details: { reason: "UPTIME_TOKEN is unset" },
    });
    expect(report.status).toBe(200);
  });

  /**
   * @case A bound indicator whose route comes back measures staleness from the re-enable, not from boot
   * @preconditions Probe route disabled at boot; indicator maxAge 150ms; the test waits 200ms, then enables the route
   * @expectedResult Right after the re-enable the indicator reads up (booting), not stale, and its reason is gone
   */
  test("a re-enabled route restarts its indicator's staleness window", async () => {
    const flag = { on: false };
    const probe = defineIndicator({
      name: "uptime",
      maxAge: "150ms",
      route: "probe-uptime",
    });
    const port = await start({ indicators: [probe] }, [
      craft()
        .id("probe-uptime")
        .enabled(() => flag.on || "UPTIME_TOKEN is unset", { refresh: "1h" })
        .from(direct())
        .to(noop()),
      craft().id("worker").from(direct()).to(noop()),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 200));

    flag.on = true;
    await t!.ctx.reevaluateEnablement("probe-uptime");

    const report = await health(port);
    expect(report.body.indicators["uptime"]).toMatchObject({
      status: "up",
      details: { booting: true },
    });
  });

  /**
   * @case An indicator disabled by its own declaration reports inactive and ignores pushes
   * @preconditions defineIndicator({ name: "ledger", enabled: "LEDGER_URL is unset" }); the app pushes down() after start
   * @expectedResult The indicator is inactive with the reason; the push is ignored, so the aggregate stays 200
   */
  test("an indicator's own enabled disables it and drops pushes", async () => {
    const ledger = defineIndicator({
      name: "ledger",
      enabled: "LEDGER_URL is unset",
    });
    const port = await start({ indicators: [ledger] }, [
      craft().id("worker").from(direct()).to(noop()),
    ]);
    ledger.down();

    const report = await health(port);
    expect(report.body.indicators["ledger"]).toEqual({
      status: "inactive",
      domain: "deployment",
      details: { reason: "LEDGER_URL is unset" },
    });
    expect(report.status).toBe(200);
  });

  /**
   * @case A predicate that throws leaves the indicator disabled, and the error becomes the reason
   * @preconditions enabled: () => { throw new Error("vault unreachable") }
   * @expectedResult The context starts; the indicator is inactive with a reason naming the indicator and the error
   */
  test("a throwing enabled predicate disables the indicator", async () => {
    const ledger = defineIndicator({
      name: "ledger",
      enabled: () => {
        throw new Error("vault unreachable");
      },
    });
    const port = await start({ indicators: [ledger] }, [
      craft().id("worker").from(direct()).to(noop()),
    ]);

    const report = await health(port);
    expect(report.body.indicators["ledger"]).toMatchObject({
      status: "inactive",
      details: {
        reason: 'indicator "ledger" enabled threw: vault unreachable',
      },
    });
  });

  /**
   * @case An enabled indicator behaves as before
   * @preconditions enabled: () => true; the app pushes down()
   * @expectedResult The indicator reports down and the aggregate is 503
   */
  test("an enabled indicator still reports what it is told", async () => {
    const ledger = defineIndicator({ name: "ledger", enabled: () => true });
    const port = await start({ indicators: [ledger] }, [
      craft().id("worker").from(direct()).to(noop()),
    ]);
    ledger.down();

    const report = await health(port);
    expect(report.body.indicators["ledger"]).toMatchObject({ status: "down" });
    expect(report.status).toBe(503);
  });

  /**
   * @case A malformed enabled value is refused at definition
   * @preconditions defineIndicator({ name: "ledger", enabled: 42 })
   * @expectedResult Throws RC5053 naming the accepted shapes
   */
  test("defineIndicator refuses a malformed enabled", () => {
    expect(() =>
      defineIndicator({ name: "ledger", enabled: 42 as never }),
    ).toThrow(/enabled must be true, false, a reason string/);
  });
});

describe("the health ledger and disabled indicators", () => {
  /**
   * @case Its own declaration's reason wins over its route's, and both must let go before it comes back
   * @preconditions A registered indicator disabled by its route ("probe off") and by itself ("not configured")
   * @expectedResult Reported reason is "not configured"; clearing the route leaves it inactive; clearing its own brings it back up
   */
  test("own and route disables combine", () => {
    let now = 0;
    const state = new HealthState({ now: () => now });
    state.contextStarted();
    state.registerIndicator("dep", { maxAgeMs: 100 });
    state.setIndicatorDisabled("dep", "route", "probe off");
    state.setIndicatorDisabled("dep", "own", "not configured");
    expect(state.indicatorComponentOf("dep")).toMatchObject({
      status: "inactive",
      details: { reason: "not configured" },
    });

    state.setIndicatorDisabled("dep", "route", undefined);
    expect(state.indicatorComponentOf("dep")?.status).toBe("inactive");

    now = 1_000;
    state.setIndicatorDisabled("dep", "own", undefined);
    expect(state.indicatorComponentOf("dep")).toMatchObject({
      status: "up",
      details: { booting: true },
    });
    now = 1_200;
    expect(state.indicatorComponentOf("dep")).toMatchObject({
      status: "down",
      details: { reason: "no-report" },
    });
  });

  /**
   * @case A report from before the disable does not survive the re-enable
   * @preconditions An indicator reported down, then disabled, then enabled again
   * @expectedResult After the re-enable it reads up (booting), not the stale down verdict
   */
  test("re-enabling forgets the last verdict", () => {
    let now = 0;
    const state = new HealthState({ now: () => now });
    state.contextStarted();
    state.registerIndicator("dep", { maxAgeMs: 100 });
    state.reportIndicator("dep", { status: "down" });
    state.setIndicatorDisabled("dep", "own", "off");
    now = 50;
    state.setIndicatorDisabled("dep", "own", undefined);
    expect(state.indicatorComponentOf("dep")).toMatchObject({
      status: "up",
      details: { booting: true },
    });
  });
});
