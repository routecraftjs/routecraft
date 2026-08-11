import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  direct,
  isSuspended,
  noop,
  type CraftConfig,
  type Suspended,
} from "../src/index.ts";
import { chainFields, chainSurvival } from "../src/pipeline/chain-policy.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const Approval = z.object({ approved: z.boolean() });

/** A context whose suspension runtime is the in-memory backend. */
function suspending(): { suspension: Record<string, never> } & CraftConfig {
  return { suspension: {} } as {
    suspension: Record<string, never>;
  } & CraftConfig;
}

/** Read the acknowledgment execution one answered with. */
function asSuspended(value: unknown): Suspended {
  if (!isSuspended(value)) {
    throw new Error(
      `expected a Suspended acknowledgment, got ${String(value)}`,
    );
  }
  return value;
}

/**
 * Which pre-from filter chain positions apply to execution two.
 *
 * A resumed exchange re-enters its route below the chain, so the positions
 * describing an arrival do not run again. The ones that do survive are
 * declared rather than inherited, and this suite is what holds that
 * declaration to its word: a position that silently stops applying is the
 * failure mode it pins against.
 */
describe("the filter chain on a resumed continuation", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Route-scope .concurrency() bounds resumed continuations, not only ingress executions
   * @preconditions A route with route-scope .concurrency({ max: 1 }) and a .suspend() before a slow step; two exchanges parked, then resumed concurrently
   * @expectedResult The observed peak simultaneity inside the continuation never exceeds the declared max, because ingress executions and resumed continuations compete for the same bulkhead, which is the downstream the limit exists to protect
   */
  test("a resumed continuation competes for the route's bulkhead", async () => {
    let inFlight = 0;
    let peak = 0;

    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .concurrency({ max: 1 })
          .from(direct())
          .suspend({ expect: Approval })
          .process(async (ex) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await sleep(40);
            inFlight--;
            return ex;
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = await Promise.all([
      t.client
        .sendDirect("payout", { amountCents: 10_000 })
        .then((body) => asSuspended(body)),
      t.client
        .sendDirect("payout", { amountCents: 20_000 })
        .then((body) => asSuspended(body)),
    ]);

    await Promise.all(
      parked.map((suspension) =>
        t!.client.sendDirect("answers", {
          token: suspension.token,
          result: { approved: true },
        }),
      ),
    );

    expect(t.errors).toHaveLength(0);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(1);
  });

  /**
   * @case An ingress execution and a resumed continuation compete for the same bulkhead
   * @preconditions .concurrency({ max: 1 }) on a route with slow work both before and after the suspend; one exchange parked, then its resume raced against a fresh exchange entering the route
   * @expectedResult Peak simultaneity across both executions stays within the declared max. The two halves of the route's traffic share one limiter rather than each getting their own
   */
  test("an ingress execution and a continuation share one limiter", async () => {
    let inFlight = 0;
    let peak = 0;

    const occupy = async <T>(ex: T): Promise<T> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(40);
      inFlight--;
      return ex;
    };

    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .concurrency({ max: 1 })
          .from(direct())
          .process(occupy)
          .suspend({ expect: Approval })
          .process(occupy)
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("payout", { amountCents: 10_000 }),
    );

    await Promise.all([
      t.client.sendDirect("answers", {
        token: parked.token,
        result: { approved: true },
      }),
      t.client.sendDirect("payout", { amountCents: 20_000 }),
    ]);

    expect(t.errors).toHaveLength(0);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(1);
  });

  /**
   * @case Route-scope .retry() re-attempts a failing continuation, and the suspension's terminal outcome is not recorded until it settles
   * @preconditions A route with route-scope .retry({ maxAttempts: 3 }) and a continuation step that throws twice before succeeding
   * @expectedResult The continuation runs three times and the resume reports a completed outcome, not a failed one: attempts happen before any terminal is recorded, so a retried continuation never spends the approval it was answering
   */
  test("a resumed continuation is retried, and settles once", async () => {
    let attempts = 0;

    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .retry({ maxAttempts: 3, backoffMs: 1 })
          .from(direct())
          .suspend({ expect: Approval })
          .process((ex) => {
            attempts++;
            if (attempts < 3) throw new Error("downstream refused");
            return ex;
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("payout", { amountCents: 10_000 }),
    );
    const receipt = (await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    })) as { status: string; outcome: { status: string } };

    expect(attempts).toBe(3);
    expect(receipt.status).toBe("resumed");
    expect(receipt.outcome.status).toBe("completed");
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case Route-scope .timeout() bounds execution two
   * @preconditions A route with route-scope .timeout(30) and a continuation step that waits well past it
   * @expectedResult The continuation is abandoned with RC5011 and the suspension records a failed terminal, rather than running unbounded because the deadline described only the ingress
   */
  test("a resumed continuation is bounded by the route timeout", async () => {
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .timeout(30)
          .from(direct())
          .suspend({ expect: Approval })
          .process(async (ex) => {
            await sleep(200);
            return ex;
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("payout", { amountCents: 10_000 }),
    );
    const receipt = (await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    })) as { outcome: { status: string; error?: { rc?: string } } };

    expect(receipt.outcome.status).toBe("failed");
    expect(receipt.outcome.error?.rc).toBe("RC5011");
  });

  /**
   * @case A saturated bulkhead delays a resumed continuation rather than refusing it
   * @preconditions .concurrency({ max: 1, mode: "reject" }) on a route with a suspend before a slow step; two exchanges parked, then resumed together so the second finds no free slot
   * @expectedResult Both continuations run and complete. A refusal here would be RC5026 recorded as the suspension's terminal outcome, destroying an approval for work that never ran, because the resume claims the suspension before the continuation starts. The bound still holds: the second waits for the slot the first is holding
   */
  test("a saturated bulkhead delays a continuation, never refuses it", async () => {
    let ran = 0;
    let inFlight = 0;
    let peak = 0;

    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .concurrency({ max: 1, mode: "reject" })
          .from(direct())
          .suspend({ expect: Approval })
          .process(async (ex) => {
            ran++;
            inFlight++;
            peak = Math.max(peak, inFlight);
            await sleep(40);
            inFlight--;
            return ex;
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = [
      asSuspended(await t.client.sendDirect("payout", { amountCents: 10_000 })),
      asSuspended(await t.client.sendDirect("payout", { amountCents: 20_000 })),
    ];
    const receipts = (await Promise.all(
      parked.map((suspension) =>
        t!.client.sendDirect("answers", {
          token: suspension.token,
          result: { approved: true },
        }),
      ),
    )) as Array<{ outcome: { status: string } }>;

    expect(receipts.map((r) => r.outcome.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(ran).toBe(2);
    expect(peak).toBeLessThanOrEqual(1);
  });

  /**
   * @case Every chain position declares whether it survives each kind of detached run
   * @preconditions The survival policy, keyed by the chain fields of RouteDefinition
   * @expectedResult The declared set matches the chain exactly, and each position carries a reason. A field added to RouteDefinition widens the key set and fails the build before it reaches this test; this pins the current answers so a silent change to one is visible in the diff
   */
  test("the survival policy covers the chain exactly", () => {
    expect([...chainFields()].sort()).toEqual([
      "circuitBreaker",
      "concurrency",
      "errorHandler",
      "postFromFilters",
      "postParseFilters",
      "preParseFilters",
      "retry",
      "throttle",
      "timeout",
    ]);

    const resumed = chainFields().filter(
      (field) => chainSurvival(field, "resume").survives,
    );
    expect([...resumed].sort()).toEqual([
      "concurrency",
      "errorHandler",
      "retry",
      "timeout",
    ]);

    // A debounce release is work the route held back and never admitted, so
    // only the error handler survives it.
    const released = chainFields().filter(
      (field) => chainSurvival(field, "debounce").survives,
    );
    expect(released).toEqual(["errorHandler"]);

    for (const field of chainFields()) {
      expect(chainSurvival(field, "resume").why.length).toBeGreaterThan(0);
    }
  });
});
