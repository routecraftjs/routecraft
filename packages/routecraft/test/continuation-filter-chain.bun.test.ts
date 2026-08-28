import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, direct, noop } from "../src/index.ts";
import { asSuspended, suspending } from "./helpers/suspension.ts";
import { CHAIN_SURVIVAL } from "../src/pipeline/chain-policy.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const Approval = z.object({ approved: z.boolean() });

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
          .suspend({ schema: Approval })
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
          .suspend({ schema: Approval })
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
          .retry({ maxAttempts: 3, backoff: 1 })
          .from(direct())
          .suspend({ schema: Approval })
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
          // A route-scope timeout bounds execution ONE as well, so the
          // ingress has to reach the park inside this deadline. Generous
          // enough that a loaded box still parks in time, while the
          // continuation's wait exceeds it several times over.
          .timeout(150)
          .from(direct())
          .suspend({ schema: Approval })
          .process(async (ex) => {
            await sleep(600);
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
   * @case A continuation abandoned by the route deadline stops below a bulkhead
   * @preconditions A route with route-scope .timeout() and .concurrency(), a continuation whose first step outlives the deadline and a second step that records whether it ran
   * @expectedResult The step after the abandoned one never runs. The deadline records a failed terminal against a suspension the resume already claimed, so continuing past it would execute the payout after telling the answerer it failed, and the approval cannot be re-spent
   */
  test("an abandoned continuation stops rather than running past its deadline", async () => {
    let after = 0;
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .timeout(150)
          .concurrency({ max: 5 })
          .from(direct())
          .suspend({ schema: Approval })
          .process(async (ex) => {
            await sleep(600);
            return ex;
          })
          .process((ex) => {
            after++;
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
    await sleep(700);
    expect(after).toBe(0);
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
          .suspend({ schema: Approval })
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
   * @case A reject-mode bulkhead still only delays a continuation when retry and timeout wrap it
   * @preconditions .retry() and .timeout() alongside .concurrency({ max: 1, mode: "reject" }) on a suspending route; two exchanges parked, then resumed together
   * @expectedResult Both continuations complete. The bulkhead segment is built from the deps that carry the waiting form, and the nested definitions retry and timeout run under carry no concurrency position of their own, so no inner segment is built that could refuse
   */
  test("retry and timeout above the bulkhead do not restore refusal", async () => {
    let ran = 0;

    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .retry({ maxAttempts: 2, backoff: 1 })
          .timeout(2_000)
          .concurrency({ max: 1, mode: "reject" })
          .from(direct())
          .suspend({ schema: Approval })
          .process(async (ex) => {
            ran++;
            await sleep(40);
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
    )) as Array<{ outcome: { status: string; error?: { rc?: string } } }>;

    expect(receipts.map((r) => r.outcome.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(receipts.every((r) => r.outcome.error?.rc !== "RC5026")).toBe(true);
    expect(ran).toBe(2);
  });

  /**
   * @case A route shut down while a continuation waits for a bulkhead slot
   * @preconditions .concurrency({ max: 1 }) with a slow continuation holding the only slot; a second continuation queued behind it when the route stops
   * @expectedResult The queued continuation is admitted with a no-op slot rather than failed. A teardown it did not cause must not spend its approval, which is the same refusal-below-the-claim rule that put the bulkhead in waiting form
   */
  test("a continuation queued at shutdown is admitted, not failed", async () => {
    let ran = 0;
    const context = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .concurrency({ max: 1 })
          .from(direct())
          .suspend({ schema: Approval })
          .process(async (ex) => {
            ran++;
            await sleep(120);
            return ex;
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await context.startAndWaitReady();

    const parked = [
      asSuspended(
        await context.client.sendDirect("payout", { amountCents: 10_000 }),
      ),
      asSuspended(
        await context.client.sendDirect("payout", { amountCents: 20_000 }),
      ),
    ];

    const answered = Promise.all(
      parked.map((suspension) =>
        context.client.sendDirect("answers", {
          token: suspension.token,
          result: { approved: true },
        }),
      ),
    );

    // Long enough for the first continuation to hold the slot and the second
    // to be parked in the wait line, short enough that neither has finished.
    await sleep(40);
    await context.stop();

    const receipts = (await answered) as Array<{
      outcome: { status: string; error?: { rc?: string } };
    }>;

    expect(ran).toBe(2);
    expect(
      receipts.every((receipt) => receipt.outcome.error?.rc !== "RC5026"),
    ).toBe(true);
  });

  /**
   * @case Every chain position declares whether it survives each kind of detached run
   * @preconditions The survival policy, keyed by the chain fields of RouteDefinition
   * @expectedResult The declared set matches the chain exactly, and each position carries a reason. A field added to RouteDefinition widens the key set and fails the build before it reaches this test; this pins the current answers so a silent change to one is visible in the diff
   */
  test("the survival policy covers the chain exactly", () => {
    const survival = Object.fromEntries(
      Object.entries(CHAIN_SURVIVAL).map(([field, kinds]) => [
        field,
        Object.fromEntries(
          Object.entries(kinds).map(([kind, policy]) => [
            kind,
            policy.survives,
          ]),
        ),
      ]),
    );

    // Asserted whole rather than as a filtered projection: a field silently
    // dropped from the record, or a kind silently added to one row and not
    // another, shows up here as a shape difference rather than passing
    // because the filter happened not to select it.
    expect(survival).toEqual({
      errorHandler: { resume: true, debounce: true, errorChannel: true },
      preParseFilters: { resume: false, debounce: false, errorChannel: false },
      postParseFilters: { resume: false, debounce: false, errorChannel: false },
      postFromFilters: { resume: false, debounce: false, errorChannel: false },
      throttle: { resume: false, debounce: false, errorChannel: false },
      circuitBreaker: { resume: false, debounce: false, errorChannel: false },
      retry: { resume: true, debounce: false, errorChannel: false },
      timeout: { resume: true, debounce: false, errorChannel: false },
      concurrency: { resume: true, debounce: false, errorChannel: false },
    });

    // Every answer states its own reason. The same position is off for
    // different reasons per kind, so a shared string would be a wrong
    // answer to two of the three questions.
    const reasons = Object.values(CHAIN_SURVIVAL).flatMap((kinds) =>
      Object.values(kinds).map((policy) => policy.why),
    );
    expect(reasons.every((why) => why.length > 0)).toBe(true);
    // Distinct, not merely present: a reason copied between kinds is a wrong
    // answer to one of the questions, which is the failure per-kind reasons
    // exist to prevent.
    expect(new Set(reasons).size).toBe(reasons.length);

    // The executor derives `admissionMustWait` from this flag, so it is the
    // record and not a `kind` comparison that decides which runs a bulkhead
    // may refuse.
    const mayNotBeRefused = Object.entries(CHAIN_SURVIVAL).flatMap(
      ([field, kinds]) =>
        Object.entries(kinds)
          .filter(([, policy]) => policy.mustNotRefuse === true)
          .map(([kind]) => `${field}.${kind}`),
    );
    expect(mayNotBeRefused).toEqual(["concurrency.resume"]);
  });
});
