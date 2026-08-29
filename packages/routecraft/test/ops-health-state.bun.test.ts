import { describe, expect, test } from "bun:test";
// The ledger class is type-only on the public entry point (it is read via
// the context store), so the unit test reaches for the module directly.
import { HealthState } from "../src/plugins/ops/state.ts";

/**
 * A ledger with a clock the test drives, so staleness is exercised without
 * waiting for wall time.
 */
function ledgerAt(start = 0): {
  state: HealthState;
  advance(ms: number): void;
} {
  let now = start;
  const state = new HealthState({ now: () => now });
  return {
    state,
    advance(ms: number) {
      now += ms;
    },
  };
}

/**
 * The judgement behind the health surface.
 *
 * The rule these pin is the one the design exists for: an exchange failing is
 * a route issue, not a health issue. A route reports `down` only when it
 * genuinely cannot serve, which means its source gave up, and `degraded` only
 * when something is actually holding calls off. Everything else about a failed
 * exchange is diagnostic context for a human.
 */
describe("the health ledger", () => {
  /**
   * @case A context that has not finished starting is not ready
   * @preconditions A fresh ledger, no lifecycle events yet
   * @expectedResult The context component is down and the report is not ready. This is what makes a deploy zero-downtime: a booting instance must refuse traffic before its routes have subscribed
   */
  test("refuses traffic until the context has started", () => {
    const { state } = ledgerAt();

    const before = state.report();
    expect(before.status).toBe("down");
    expect(before.context.status).toBe("down");
    expect(before.context.details).toEqual({ state: "starting" });

    state.contextStarted();
    expect(state.report().status).not.toBe("down");
  });

  /**
   * @case Shutdown refuses traffic immediately, before routes are torn down
   * @preconditions A started context that then reports stopping
   * @expectedResult Readiness flips to not-ready at `stopping`. The listener stays up through the drain, which is the window that lets a load balancer stop sending work while in-flight exchanges finish
   */
  test("refuses traffic as soon as shutdown begins", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    expect(state.report("readiness").status).not.toBe("down");

    state.contextStopping();

    expect(state.report("readiness").status).toBe("down");
    expect(state.report().context.details).toEqual({ state: "stopping" });
  });

  /**
   * @case Failing exchanges never change a route's status, whatever the streak
   * @preconditions A running route that fails forty exchanges in a row
   * @expectedResult The route stays up and the report stays ready, carrying the failure count as diagnostic detail. Many errors are expected (a refused caller, a validation error, a business rule saying no) and paging on them turns every scope gap into an incident
   */
  test("counts failing exchanges without escalating them", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    state.routeStarted("orders");

    for (let i = 0; i < 40; i++) state.exchangeFailed("orders");

    const report = state.report();
    expect(report.status).toBe("up");
    expect(report.routes["orders"]?.status).toBe("up");
    expect(report.routes["orders"]?.details).toEqual({
      lifecycle: "running",
      failures: 40,
    });
  });

  /**
   * @case A completed exchange resets the failure run
   * @preconditions A route with failures recorded, then one success
   * @expectedResult The counter clears and drops out of details. The count answers "is it failing right now", not "has it ever failed"
   */
  test("resets the failure count when an exchange completes", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    state.routeStarted("orders");
    state.exchangeFailed("orders");
    state.exchangeFailed("orders");

    state.exchangeCompleted("orders");

    expect(state.report().routes["orders"]?.details).toEqual({
      lifecycle: "running",
    });
  });

  /**
   * @case A dead source takes the route, and the aggregate, down
   * @preconditions A running route whose source gives up producing
   * @expectedResult The route is down and the report is not ready. This is the genuine liveness signal: nothing the route exists to serve is being served
   */
  test("reports a route down when its source gives up", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    state.routeStarted("mail-intake");

    state.sourceDied("mail-intake");

    const report = state.report();
    expect(report.status).toBe("down");
    expect(report.status).toBe("down");
    expect(report.routes["mail-intake"]).toMatchObject({
      status: "down",
      domain: "deployment",
      details: { lifecycle: "failed" },
    });
  });

  /**
   * @case An open circuit breaker degrades the route without paging
   * @preconditions A running route with one route-scope breaker open
   * @expectedResult The route is degraded, the aggregate is degraded, and the report stays ready. The breaker is the one thing that turns repeated failure into a health signal, because it is the one thing that actually stops the route serving
   */
  test("degrades a route while a breaker holds calls off", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    state.routeStarted("invoice-sync");

    state.circuitOpened("invoice-sync", "route", "open");

    const report = state.report();
    expect(report.status).toBe("degraded");
    expect(report.status).not.toBe("down");
    expect(report.routes["invoice-sync"]).toMatchObject({
      status: "degraded",
      details: { lifecycle: "running", circuit: "open", breakers: "route" },
    });

    state.circuitClosed("invoice-sync", "route");
    expect(state.report().routes["invoice-sync"]?.status).toBe("up");
  });

  /**
   * @case Several breakers on one route are tracked independently
   * @preconditions Two step-scope breakers open, then one closes
   * @expectedResult The route stays degraded while any breaker holds calls off, and the details name both labels. A route may wrap several steps in their own breaker
   */
  test("tracks breakers per label", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    state.routeStarted("sync");

    state.circuitOpened("sync", "fetch", "open");
    state.circuitOpened("sync", "push", "half-open");

    expect(state.report().routes["sync"]?.details).toMatchObject({
      circuit: "open",
      breakers: "fetch,push",
    });

    state.circuitClosed("sync", "fetch");
    expect(state.report().routes["sync"]).toMatchObject({
      status: "degraded",
      details: { circuit: "half-open", breakers: "push" },
    });
  });

  /**
   * @case A deliberately disabled route is visible but never pages
   * @preconditions A running route taken offline
   * @expectedResult It reports degraded rather than disappearing into inactive, so the aggregate shows reduced capability while staying 200 and leaving readiness untouched
   */
  test("reports a disabled route as degraded", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    state.routeStarted("nightly-export");

    state.setRouteOffline("nightly-export", true);

    const report = state.report();
    expect(report.status).toBe("degraded");
    expect(report.status).not.toBe("down");
    expect(report.routes["nightly-export"]).toMatchObject({
      status: "degraded",
      details: { lifecycle: "offline" },
    });

    state.setRouteOffline("nightly-export", false);
    expect(state.report().routes["nightly-export"]?.status).toBe("up");
  });

  /**
   * @case A finished one-shot is listed but excluded from aggregation
   * @preconditions A route that ran an exchange successfully and then stopped
   * @expectedResult It reports inactive and the aggregate stays up. Not every route is long-running, and a one-shot closing is success rather than death
   */
  test("excludes a finished one-shot from aggregation", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    state.routeStarted("migrate");
    state.exchangeCompleted("migrate");

    state.routeStopped("migrate");

    const report = state.report();
    expect(report.routes["migrate"]).toMatchObject({
      status: "inactive",
      details: { lifecycle: "completed" },
    });
    expect(report.status).toBe("up");
  });

  /**
   * @case A route that stopped without ever succeeding is still not a failure
   * @preconditions A route stopped with no completed exchange
   * @expectedResult It reports inactive with a `stopped` lifecycle, distinct from the `completed` of one that did work. Disposition on stop is decided by what the route achieved
   */
  test("distinguishes a stopped route from a completed one", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    state.routeStarted("idle");

    state.routeStopped("idle");

    expect(state.report().routes["idle"]).toMatchObject({
      status: "inactive",
      details: { lifecycle: "stopped" },
    });
  });

  /**
   * @case A dead route keeps its verdict when the context later stops it
   * @preconditions A route whose source died, then a normal stop during shutdown
   * @expectedResult It stays down rather than being relabelled as a clean stop, so a shutdown cannot erase the reason the route failed
   */
  test("keeps a failed route failed through shutdown", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    state.routeStarted("mail-intake");
    state.sourceDied("mail-intake");

    state.routeStopped("mail-intake");

    expect(state.report().routes["mail-intake"]?.status).toBe("down");
  });

  /**
   * @case An in-flight exchange settling after the source died cannot revive the route
   * @preconditions A route whose source died, then a completed exchange, then the stop
   * @expectedResult It stays down and the aggregate stays down. route:source:failed is emitted before the route's controller aborts, so exchanges already in flight settle afterwards; treating one as evidence of life would clear the failure, and the later stop would then read as a clean finish and drop the route out of aggregation entirely
   */
  test("keeps a failed route failed when a late exchange completes", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    state.routeStarted("mail-intake");
    state.sourceDied("mail-intake");

    state.exchangeCompleted("mail-intake");
    expect(state.report().routes["mail-intake"]?.status).toBe("down");

    state.routeStopped("mail-intake");
    expect(state.report().routes["mail-intake"]?.status).toBe("down");
    expect(state.report().status).toBe("down");
  });

  /**
   * @case Bringing a route back online cannot revive a dead source
   * @preconditions A route whose source died, then taken offline and back online
   * @expectedResult It stays down. Returning a route to service says the operator wants it serving, not that its source recovered, so only a restart may clear the failure
   */
  test("keeps a failed route failed across an offline round trip", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    state.routeStarted("nightly-export");
    state.sourceDied("nightly-export");

    state.setRouteOffline("nightly-export", true);
    state.setRouteOffline("nightly-export", false);

    expect(state.report().routes["nightly-export"]?.status).toBe("down");
    expect(state.report().status).toBe("down");
  });

  /**
   * @case A pushed details map cannot be rewritten after the fact
   * @preconditions An indicator reported down with a details object the caller keeps, then mutates, and a report whose details the reader mutates
   * @expectedResult Neither mutation reaches a later report. The ledger is handed the caller's object and hands one back to every reader, so sharing either reference would let a verdict be rewritten after it was recorded
   */
  test("copies indicator details in and out", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    state.registerIndicator("mail");

    const pushed = { subsystem: "imap" };
    state.reportIndicator("mail", { status: "down", details: pushed });
    pushed.subsystem = "rewritten-by-caller";

    const first = state.report().indicators["mail"];
    expect(first?.details).toMatchObject({ subsystem: "imap" });

    (first?.details as Record<string, string>)["subsystem"] =
      "rewritten-by-reader";

    expect(state.report().indicators["mail"]?.details).toMatchObject({
      subsystem: "imap",
    });
  });

  /**
   * @case An indicator with no staleness window is only as fresh as its last push
   * @preconditions An indicator registered without maxAgeMs, reported up, then a long wait
   * @expectedResult It stays up. This is the right reading for an indicator fed from a business route that may legitimately be idle for hours
   */
  test("never staleness-checks an indicator with no window", () => {
    const { state, advance } = ledgerAt();
    state.contextStarted();
    state.registerIndicator("licence");
    state.reportIndicator("licence", { status: "up" });

    advance(72 * 60 * 60_000);

    expect(state.report().indicators["licence"]?.status).toBe("up");
  });

  /**
   * @case An indicator on a cadence goes down once its window lapses
   * @preconditions An indicator with a 15 minute window, reported up, then 16 minutes of silence
   * @expectedResult It reports down with reason `stale`. A probe that stops running is itself a signal, since the dependency is no longer being checked
   */
  test("marks a cadenced indicator stale once its window lapses", () => {
    const { state, advance } = ledgerAt();
    state.contextStarted();
    state.registerIndicator("mail", { maxAgeMs: 15 * 60_000 });
    state.reportIndicator("mail", { status: "up" });

    advance(14 * 60_000);
    expect(state.report().indicators["mail"]?.status).toBe("up");

    advance(2 * 60_000);
    const report = state.report();
    expect(report.indicators["mail"]).toMatchObject({
      status: "down",
      details: { reason: "stale" },
    });
    expect(report.status).toBe("down");
  });

  /**
   * @case An indicator that has never reported is healthy through boot grace
   * @preconditions An indicator with a window, registered before the context started, never reported
   * @expectedResult Healthy until the window has elapsed since the context started, down afterwards. Without the grace, every boot would flap red before the first probe fires
   */
  test("gives an indicator that has never reported until its window elapses", () => {
    const { state, advance } = ledgerAt();
    state.registerIndicator("mail", { maxAgeMs: 10 * 60_000 });
    state.contextStarted();

    advance(9 * 60_000);
    expect(state.report().indicators["mail"]).toMatchObject({
      status: "up",
      details: { booting: true },
    });

    advance(2 * 60_000);
    expect(state.report().indicators["mail"]).toMatchObject({
      status: "down",
      details: { reason: "no-report" },
    });
  });

  /**
   * @case A parked indicator never pages and never blocks readiness
   * @preconditions An indicator reported down, then parked for maintenance
   * @expectedResult It reports inactive and the aggregate returns to up. Maintenance is deliberate, so it must not look like an outage
   */
  test("excludes a parked indicator from aggregation", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    state.registerIndicator("mail");
    state.reportIndicator("mail", { status: "down" });
    expect(state.report().status).toBe("down");

    state.setIndicatorInactive("mail", true);

    const report = state.report();
    expect(report.indicators["mail"]?.status).toBe("inactive");
    expect(report.status).toBe("up");
  });

  /**
   * @case Readiness carries only instance-domain components
   * @preconditions A deployment-domain indicator down and an instance-domain one up
   * @expectedResult Operational health is down while readiness stays ready. Derotating an instance for a deployment-wide failure just moves traffic to a peer that fails identically, emptying the pool
   */
  test("keeps deployment-domain failures out of readiness", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    state.registerIndicator("mail", { domain: "deployment" });
    state.registerIndicator("disk", { domain: "instance" });
    state.reportIndicator("mail", { status: "down" });
    state.reportIndicator("disk", { status: "up" });

    const all = state.report("all");
    expect(all.status).toBe("down");
    expect(all.status).toBe("down");

    const readiness = state.report("readiness");
    expect(readiness.status).not.toBe("down");
    expect(readiness.indicators["mail"]).toBeUndefined();
    expect(readiness.indicators["disk"]?.status).toBe("up");
  });

  /**
   * @case An instance-domain failure does refuse traffic
   * @preconditions An indicator declaring the instance domain, reported down
   * @expectedResult Readiness goes not-ready. Moving traffic to a peer genuinely helps when the failure is local to this replica, which is the only case where derotation is the right response
   */
  test("lets an instance-domain failure refuse traffic", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    state.registerIndicator("disk", { domain: "instance" });

    state.reportIndicator("disk", { status: "down" });

    expect(state.report("readiness").status).toBe("down");
  });

  /**
   * @case A route is never an instance-domain component
   * @preconditions A running route in a started context
   * @expectedResult Its domain is deployment and it never appears in readiness. No route can declare otherwise in this version, so this holds by construction
   */
  test("keeps routes out of the readiness view", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    state.routeStarted("orders");
    state.sourceDied("orders");

    expect(state.report().routes["orders"]?.domain).toBe("deployment");
    expect(state.report("readiness").routes["orders"]).toBeUndefined();
    expect(state.report("readiness").status).not.toBe("down");
  });

  /**
   * @case The aggregate status rolls up down over degraded over up
   * @preconditions One degraded route and one down indicator in the same report
   * @expectedResult The aggregate reports down, because the most severe non-inactive component decides it
   */
  test("rolls the aggregate up to the most severe component", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    state.routeStarted("sync");
    state.circuitOpened("sync", "route", "open");
    state.registerIndicator("mail");

    expect(state.report().status).toBe("degraded");

    state.reportIndicator("mail", { status: "down" });
    expect(state.report().status).toBe("down");
  });

  /**
   * @case A report whose components are all inactive is healthy
   * @preconditions A started context whose only route is a finished one-shot
   * @expectedResult Up, ready, because nothing has said this instance cannot serve
   */
  test("treats an all-inactive report as healthy", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    state.routeStarted("migrate");
    state.exchangeCompleted("migrate");
    state.routeStopped("migrate");

    const report = state.report();
    expect(report.status).toBe("up");
  });

  /**
   * @case Per-component lookups answer for one component
   * @preconditions A tracked route and indicator, plus names that do not exist
   * @expectedResult The known names resolve to their component and the unknown ones resolve to undefined, which the endpoint turns into a 404
   */
  test("resolves single components by name", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    state.routeStarted("orders");
    state.registerIndicator("mail");

    expect(state.routeComponentOf("orders")?.status).toBe("up");
    expect(state.indicatorComponentOf("mail")?.status).toBe("up");
    expect(state.routeLifecycle("orders")).toBe("running");
    expect(state.routeComponentOf("nope")).toBeUndefined();
    expect(state.indicatorComponentOf("nope")).toBeUndefined();
  });

  /**
   * @case A push to an unregistered indicator is ignored rather than inventing a component
   * @preconditions A report call after pushing a name nothing registered
   * @expectedResult The indicator does not appear. Registration is what puts a component in the report, so a stray push cannot conjure one
   */
  test("ignores a report for an unregistered indicator", () => {
    const { state } = ledgerAt();
    state.contextStarted();

    state.reportIndicator("ghost", { status: "down" });

    expect(state.report().indicators["ghost"]).toBeUndefined();
    expect(state.report().status).toBe("up");
  });

  /**
   * @case A route held back by its predicate reports disabled, with its reason, and does not degrade health
   * @preconditions A started context with one running route and one disabled by its enabled() predicate
   * @expectedResult The disabled route is listed as inactive carrying its reason, and the overall report stays up. This is the point of the feature: a capability whose credentials were never supplied is a configuration state, not an incident, and must never page
   */
  test("reports a disabled route without degrading the aggregate", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    state.routeStarted("triage");
    state.setRouteDisabled(
      "mail-inbound",
      "MAIL_USER and MAIL_APP_PASSWORD are not set",
    );

    const report = state.report();
    const disabled = report.routes["mail-inbound"];

    expect(disabled?.status).toBe("inactive");
    expect(disabled?.details?.["lifecycle"]).toBe("disabled");
    expect(disabled?.details?.["reason"]).toBe(
      "MAIL_USER and MAIL_APP_PASSWORD are not set",
    );
    expect(report.status).toBe("up");
  });

  /**
   * @case Disabled is distinct from failed and from offline
   * @preconditions Three routes in the same ledger: one disabled, one whose source died, one taken offline
   * @expectedResult Each maps to its own status, so an operator can tell a deliberate configuration state from a dead source and from a derotated capability
   */
  test("keeps disabled distinct from failed and offline", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    state.routeStarted("derotated");
    state.setRouteDisabled("dormant", "no credentials");
    state.sourceDied("dead");
    state.setRouteOffline("derotated", true);

    const report = state.report();

    expect(report.routes["dormant"]?.status).toBe("inactive");
    expect(report.routes["dead"]?.status).toBe("down");
    expect(report.routes["derotated"]?.status).toBe("degraded");
    // The dead source is the only thing that should be able to do this.
    expect(report.status).toBe("down");
  });

  /**
   * @case An exchange draining out of a route that was just disabled does not report it running again
   * @preconditions A disabled route whose in-flight exchange completes after the flip
   * @expectedResult The route stays disabled with its reason, because a drain settling is not evidence the route is serving
   */
  test("keeps a draining disabled route disabled", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    state.routeStarted("draining");
    state.setRouteDisabled("draining", "switched off");
    state.exchangeCompleted("draining");

    const component = state.routeComponentOf("draining");

    expect(component?.details?.["lifecycle"]).toBe("disabled");
    expect(component?.details?.["reason"]).toBe("switched off");
  });

  /**
   * @case A re-enabled route reports running once it starts
   * @preconditions A disabled route whose predicate passes, then starts
   * @expectedResult The disabled reason is gone and the route reports up
   */
  test("clears the disabled reason when a route is re-enabled", () => {
    const { state } = ledgerAt();
    state.contextStarted();
    state.setRouteDisabled("late", "TOKEN is not set");
    state.clearRouteDisabled("late");
    state.routeStarted("late");

    const component = state.routeComponentOf("late");

    expect(component?.status).toBe("up");
    expect(component?.details?.["reason"]).toBeUndefined();
  });
});
