import { afterEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, direct, rcError } from "@routecraft/routecraft";
import {
  CircuitBreakerMachine,
  resolveCircuitBreakerOptions,
  type CircuitBreakerHooks,
} from "../src/operations/circuit-breaker-wrapper.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build a {@link CircuitBreakerHooks} that records transitions as flat
 * strings so the state-machine tests can assert the exact sequence
 * without caring about event payloads (covered by the integration tests).
 */
function recorder(): { events: string[]; hooks: CircuitBreakerHooks } {
  const events: string[] = [];
  return {
    events,
    hooks: {
      onOpened: (count) => void events.push(`opened:${count}`),
      onHalfOpen: () => void events.push("halfOpen"),
      onClosed: () => void events.push("closed"),
      onRejected: (state) => void events.push(`rejected:${state}`),
    },
  };
}

describe("CircuitBreakerMachine (state transitions)", () => {
  /**
   * @case Counted failures up to the threshold trip the breaker
   * @preconditions failureThreshold 3, all failures inside the window, each call admitted while closed
   * @expectedResult State is open only after the third failure; the opened transition reports the failure count
   */
  test("trips from closed to open at the failure threshold", () => {
    const m = new CircuitBreakerMachine(
      resolveCircuitBreakerOptions({ failureThreshold: 3, windowMs: 1000 }),
    );
    const { events, hooks } = recorder();

    for (let i = 0; i < 3; i++) {
      const d = m.acquire(i, hooks);
      expect(d).toEqual({ admitted: true, probe: false });
      m.recordFailure(i, false, true, hooks);
    }

    expect(m.state).toBe("open");
    expect(events).toEqual(["opened:3"]);
  });

  /**
   * @case The failure window genuinely slides
   * @preconditions failureThreshold 3, windowMs 100; two failures at t=0,10 then one at t=200
   * @expectedResult The two stale failures are pruned, so the late failure leaves the breaker closed
   */
  test("prunes failures older than the window so it never trips on stale ones", () => {
    const m = new CircuitBreakerMachine(
      resolveCircuitBreakerOptions({ failureThreshold: 3, windowMs: 100 }),
    );
    const { events, hooks } = recorder();

    m.recordFailure(0, false, true, hooks);
    m.recordFailure(10, false, true, hooks);
    m.recordFailure(200, false, true, hooks);

    expect(m.state).toBe("closed");
    expect(events).toEqual([]);
  });

  /**
   * @case An open breaker fast-fails until the cooldown elapses, then probes
   * @preconditions failureThreshold 1, cooldownMs 100; trip at t=0, acquire at t=50 and t=150
   * @expectedResult The t=50 acquire is rejected (open); the t=150 acquire transitions to half-open and admits a probe
   */
  test("open rejects within cooldown and half-opens after it", () => {
    const m = new CircuitBreakerMachine(
      resolveCircuitBreakerOptions({ failureThreshold: 1, cooldownMs: 100 }),
    );
    const { events, hooks } = recorder();

    m.acquire(0, hooks);
    m.recordFailure(0, false, true, hooks);
    expect(m.state).toBe("open");

    const rejected = m.acquire(50, hooks);
    expect(rejected.admitted).toBe(false);
    if (!rejected.admitted) {
      expect(rejected.state).toBe("open");
      expect(rejected.retryAfterMs).toBe(50);
    }

    const probe = m.acquire(150, hooks);
    expect(probe).toEqual({ admitted: true, probe: true });
    expect(m.state).toBe("half-open");
    expect(events).toEqual(["opened:1", "rejected:open", "halfOpen"]);
  });

  /**
   * @case A successful probe closes the breaker; a failed probe re-opens it
   * @preconditions failureThreshold 1, cooldownMs 100; trip, half-open at t=150, then resolve the probe
   * @expectedResult Success returns the breaker to closed; failure returns it to open
   */
  test("half-open closes on probe success and re-opens on probe failure", () => {
    const closing = new CircuitBreakerMachine(
      resolveCircuitBreakerOptions({ failureThreshold: 1, cooldownMs: 100 }),
    );
    let r = recorder();
    closing.acquire(0, r.hooks);
    closing.recordFailure(0, false, true, r.hooks);
    const probe = closing.acquire(150, r.hooks);
    expect(probe.admitted && probe.probe).toBe(true);
    closing.recordSuccess(true, r.hooks);
    expect(closing.state).toBe("closed");
    expect(r.events).toEqual(["opened:1", "halfOpen", "closed"]);

    const reopening = new CircuitBreakerMachine(
      resolveCircuitBreakerOptions({ failureThreshold: 1, cooldownMs: 100 }),
    );
    r = recorder();
    reopening.acquire(0, r.hooks);
    reopening.recordFailure(0, false, true, r.hooks);
    reopening.acquire(150, r.hooks);
    reopening.recordFailure(150, true, true, r.hooks);
    expect(reopening.state).toBe("open");
    expect(r.events).toEqual(["opened:1", "halfOpen", "opened:1"]);
  });

  /**
   * @case Half-open admits at most halfOpenMax concurrent probes
   * @preconditions failureThreshold 1, cooldownMs 100, halfOpenMax 1; two acquires after cooldown before either resolves
   * @expectedResult The first probe is admitted; the second is rejected (half-open at capacity)
   */
  test("half-open caps concurrent probes at halfOpenMax", () => {
    const m = new CircuitBreakerMachine(
      resolveCircuitBreakerOptions({
        failureThreshold: 1,
        cooldownMs: 100,
        halfOpenMax: 1,
      }),
    );
    const { hooks } = recorder();

    m.acquire(0, hooks);
    m.recordFailure(0, false, true, hooks);

    const first = m.acquire(150, hooks);
    const second = m.acquire(150, hooks);

    expect(first).toEqual({ admitted: true, probe: true });
    expect(second.admitted).toBe(false);
    if (!second.admitted) expect(second.state).toBe("half-open");
  });

  /**
   * @case Non-counting failures never trip the breaker
   * @preconditions failureThreshold 1; a single failure recorded with counts=false
   * @expectedResult The breaker stays closed and emits no transition
   */
  test("a failure flagged as non-counting does not trip the breaker", () => {
    const m = new CircuitBreakerMachine(
      resolveCircuitBreakerOptions({ failureThreshold: 1 }),
    );
    const { events, hooks } = recorder();

    m.acquire(0, hooks);
    m.recordFailure(0, false, false, hooks);

    expect(m.state).toBe("closed");
    expect(events).toEqual([]);
  });
});

describe("Circuit breaker step scope (.circuitBreaker() after .from())", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Once tripped, the breaker fast-fails with the fallback without running the wrapped step
   * @preconditions failureThreshold 2, long cooldown, fallback set; two failing calls then two more
   * @expectedResult The wrapped step runs only twice; later calls return the fallback body and continue to the sink
   */
  test("fast-fails with fallback after tripping, skipping the wrapped step", async () => {
    const sink = spy();
    let calls = 0;

    t = await testContext()
      .routes(
        craft()
          .id("cb-step-fallback")
          .from(direct())
          .circuitBreaker({
            failureThreshold: 2,
            cooldownMs: 10_000,
            fallback: () => "FALLBACK",
          })
          .transform(() => {
            calls++;
            throw new Error("downstream down");
          })
          .to(sink),
      )
      .build();

    await t.startAndWaitReady();
    await expect(
      t.client.sendDirect("cb-step-fallback", "a"),
    ).rejects.toThrow();
    await expect(
      t.client.sendDirect("cb-step-fallback", "b"),
    ).rejects.toThrow();
    await t.client.sendDirect("cb-step-fallback", "c");
    await t.client.sendDirect("cb-step-fallback", "d");

    expect(calls).toBe(2);
    expect(sink.received.map((e) => e.body)).toEqual(["FALLBACK", "FALLBACK"]);
  });

  /**
   * @case With no fallback, an open breaker throws RC5025
   * @preconditions failureThreshold 1, long cooldown, no fallback; one failing call then another
   * @expectedResult The second call is rejected with RC5025 without running the wrapped step
   */
  test("throws RC5025 when open and no fallback is configured", async () => {
    let calls = 0;

    t = await testContext()
      .routes(
        craft()
          .id("cb-step-throw")
          .from(direct())
          .circuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 })
          .transform(() => {
            calls++;
            throw new Error("downstream down");
          })
          .to(spy()),
      )
      .build();

    await t.startAndWaitReady();
    await expect(t.client.sendDirect("cb-step-throw", "a")).rejects.toThrow();
    const rejection = await t.client
      .sendDirect("cb-step-throw", "b")
      .then(() => undefined)
      .catch((err: unknown) => err);

    expect(calls).toBe(1);
    expect((rejection as { rc?: string }).rc).toBe("RC5025");
  });

  /**
   * @case The breaker emits opened and rejected with step scope
   * @preconditions failureThreshold 2, no fallback; two failing calls trip it, a third is rejected
   * @expectedResult One route:circuitBreaker:opened (scope step, failureCount 2, threshold 2) and a route:circuitBreaker:rejected (scope step, state open)
   */
  test("emits opened and rejected events with scope step", async () => {
    const opened: Array<Record<string, unknown>> = [];
    const rejected: Array<Record<string, unknown>> = [];

    t = await testContext()
      .on("route:circuitBreaker:opened", (p) => {
        opened.push(p.details as Record<string, unknown>);
      })
      .on("route:circuitBreaker:rejected", (p) => {
        rejected.push(p.details as Record<string, unknown>);
      })
      .routes(
        craft()
          .id("cb-step-events")
          .from(direct())
          .circuitBreaker({ failureThreshold: 2, cooldownMs: 10_000 })
          .transform(() => {
            throw new Error("downstream down");
          })
          .to(spy()),
      )
      .build();

    await t.startAndWaitReady();
    await t.client.sendDirect("cb-step-events", "a").catch(() => {});
    await t.client.sendDirect("cb-step-events", "b").catch(() => {});
    await t.client.sendDirect("cb-step-events", "c").catch(() => {});

    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      scope: "step",
      failureCount: 2,
      threshold: 2,
    });
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(rejected[0]).toMatchObject({ scope: "step", state: "open" });
  });

  /**
   * @case Deterministic (non-retryable) errors do not count toward the threshold
   * @preconditions failureThreshold 2; the wrapped step always throws a non-retryable RoutecraftError (RC5012)
   * @expectedResult Every call runs the step (the breaker never trips), so it is called for all four sends
   */
  test("does not count non-retryable errors toward the threshold", async () => {
    const opened: unknown[] = [];
    let calls = 0;

    t = await testContext()
      .on("route:circuitBreaker:opened", (p) => {
        opened.push(p.details);
      })
      .routes(
        craft()
          .id("cb-step-noncounting")
          .from(direct())
          .circuitBreaker({ failureThreshold: 2, cooldownMs: 10_000 })
          .transform(() => {
            calls++;
            throw rcError("RC5012");
          })
          .to(spy()),
      )
      .build();

    await t.startAndWaitReady();
    for (const body of ["a", "b", "c", "d"]) {
      await t.client.sendDirect("cb-step-noncounting", body).catch(() => {});
    }

    expect(calls).toBe(4);
    expect(opened).toHaveLength(0);
  });

  /**
   * @case After the cooldown, a successful probe closes the breaker
   * @preconditions failureThreshold 1, cooldownMs 30, no fallback; trip while failing, then recover after the cooldown
   * @expectedResult halfOpen then closed events fire and post-recovery calls deliver the real body
   */
  test("recovers through half-open to closed after the cooldown", async () => {
    const sink = spy();
    const transitions: string[] = [];
    let fail = true;
    let calls = 0;

    t = await testContext()
      .on("route:circuitBreaker:halfOpen", () => {
        transitions.push("halfOpen");
      })
      .on("route:circuitBreaker:closed", () => {
        transitions.push("closed");
      })
      .routes(
        craft()
          .id("cb-step-recover")
          .from<string>(direct())
          .circuitBreaker({ failureThreshold: 1, cooldownMs: 30 })
          .transform((body: string) => {
            calls++;
            if (fail) throw new Error("downstream down");
            return body.toUpperCase();
          })
          .to(sink),
      )
      .build();

    await t.startAndWaitReady();
    // Trip the breaker, then confirm it is open (RC5025, step not run).
    await t.client.sendDirect("cb-step-recover", "a").catch(() => {});
    await expect(t.client.sendDirect("cb-step-recover", "b")).rejects.toThrow();

    // Downstream recovers; wait out the cooldown so the next call probes.
    fail = false;
    await sleep(60);
    await t.client.sendDirect("cb-step-recover", "c");
    await t.client.sendDirect("cb-step-recover", "d");

    expect(transitions).toEqual(["halfOpen", "closed"]);
    // a (fail) + c (probe) + d (closed) ran the step; b was rejected by the
    // open breaker without running it.
    expect(calls).toBe(3);
    expect(sink.received.map((e) => e.body)).toEqual(["C", "D"]);
  });
});

describe("Circuit breaker route scope (.circuitBreaker() before .from())", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case A route-scope breaker protects the whole pipeline and short-circuits to the fallback
   * @preconditions failureThreshold 1, fallback set; one failing call trips it, a second is served the fallback
   * @expectedResult The pipeline (transform + sink) runs once; once open the whole tail is skipped and opened fires with scope route
   */
  test("short-circuits the whole pipeline to the fallback when open", async () => {
    const sink = spy();
    const opened: Array<Record<string, unknown>> = [];
    let calls = 0;

    t = await testContext()
      .on("route:circuitBreaker:opened", (p) => {
        opened.push(p.details as Record<string, unknown>);
      })
      .routes(
        craft()
          .id("cb-route")
          .circuitBreaker({
            failureThreshold: 1,
            cooldownMs: 10_000,
            fallback: () => "ROUTE-FALLBACK",
          })
          .from(direct())
          .transform(() => {
            calls++;
            throw new Error("downstream down");
          })
          .to(sink),
      )
      .build();

    await t.startAndWaitReady();
    await expect(t.client.sendDirect("cb-route", "a")).rejects.toThrow();
    await t.client.sendDirect("cb-route", "b");
    await t.client.sendDirect("cb-route", "c");

    // Only the first call reached the pipeline; the rest were short-circuited.
    expect(calls).toBe(1);
    expect(sink.received).toHaveLength(0);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ scope: "route", threshold: 1 });
  });
});
