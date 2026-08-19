import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import {
  MemorySuspensionStore,
  SUSPENSION_RUNTIME,
  SuspendSignal,
  craft,
  direct,
  markSuspendCapable,
  noop,
  simple,
  takeResumeStepState,
  type Enricher,
  type Exchange,
} from "../src/index.ts";
import { asSuspended, storeWith, suspending } from "./helpers/suspension.ts";

const Approval = z.object({ approved: z.boolean() });

const SECRET = "reentrant-suspend-test-secret-key-0123456789";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A minimal suspend-capable enricher: parks on first execution (carrying
 * step-owned state), and on re-entry reports what it was handed back. The
 * agent tier is the shipped implementation of this protocol; this adapter
 * exercises the core seam without any AI machinery.
 */
function suspendCapable(): Enricher<unknown, unknown> {
  const adapter: Enricher<unknown, unknown> = {
    fetch: (ex: Exchange<unknown>) => {
      const state = takeResumeStepState(ex);
      if (state !== undefined) {
        return { resumed: true, state, answer: ex.suspension.result };
      }
      throw new SuspendSignal({
        expect: Approval,
        ttl: "1h",
        question: "may I?",
        reason: "awaiting-approval",
        stepState: { n: 1 },
      });
    },
  };
  markSuspendCapable(adapter);
  return adapter;
}

describe("re-entrant suspend sites (suspend-capable steps)", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A suspend-capable step parks with stepState and re-enters ITSELF on resume
   * @preconditions A .to(capable) step on the main flow; the signal carries stepState { n: 1 }; a resume ingress
   * @expectedResult Execution one answers with the acknowledgment (question and reason populated); the resume re-runs the step, which receives the persisted stepState and the raw answer, and the steps after it run once
   */
  test("a capable step parks, and resume re-enters the step with stepState", async () => {
    const sink = spy();
    t = await testContext()
      .with(suspending())
      .routes([
        craft().id("capable").from(direct()).to(suspendCapable()).to(sink),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("capable", "work"));
    expect(parked.question).toBe("may I?");
    expect(parked.reason).toBe("awaiting-approval");
    expect(sink.received).toHaveLength(0);

    const ack = (await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    })) as { status: string; outcome: { status: string } };
    expect(ack.status).toBe("resumed");
    expect(ack.outcome.status).toBe("completed");

    expect(sink.received).toHaveLength(1);
    expect(sink.received[0]!.body).toEqual({
      resumed: true,
      state: { n: 1 },
      answer: { approved: true },
    });
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case A step-scope wrapper around a capable step forwards the suspend site to the inner host
   * @preconditions .timeout(5000) staged as a step-scope wrapper around .to(capable)
   * @expectedResult The suspension converts inside the step and parks normally: the wrapper observes the outcome, never the raw throw (a retry wrapper would otherwise re-run the park)
   */
  test("a wrapped capable step still parks (site forwarded through the wrapper)", async () => {
    const sink = spy();
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("wrapped")
          .from(direct())
          .timeout(5_000)
          .to(suspendCapable())
          .to(sink),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("wrapped", "work"));
    expect(parked.status).toBe("suspended");
    expect(sink.received).toHaveLength(0);
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case A runtime suspension inside a .split() fan-out is refused with RC5051, not parked
   * @preconditions A capable step under an unbalanced .split(); the route BUILDS (suspendability is dynamic), and a child then suspends
   * @expectedResult The child's dispatch fails with RC5051 naming the split refusal, and nothing is written to the store
   */
  test("a suspension from inside .split() is refused at runtime with RC5051", async () => {
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("bulk")
          .from(simple(["one"]))
          .split()
          .to(suspendCapable())
          .to(noop()),
      ])
      .build();

    await t.test();
    expect(t.errors.length).toBeGreaterThan(0);
    expect(t.errors[0]).toMatchObject({ rc: "RC5051" });
    expect((t.errors[0] as Error).message).toMatch(/split/i);
    const runtime = t.ctx.getStore(SUSPENSION_RUNTIME)!;
    expect((await runtime.store.pending()).count).toBe(0);
  });

  /**
   * @case A runtime suspension inside a .multicast() path is refused with RC5051, not parked
   * @preconditions A capable step inside a multicast path; the route builds, the path exchange then suspends
   * @expectedResult The path fails with RC5051 naming the side-flow refusal, and nothing is written to the store
   */
  test("a suspension from inside .multicast() is refused at runtime with RC5051", async () => {
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("fanout")
          .from(simple("work"))
          .multicast((b) => b.to(suspendCapable()))
          .to(noop()),
      ])
      .build();

    await t.test();
    expect(t.errors.length).toBeGreaterThan(0);
    expect(t.errors[0]).toMatchObject({ rc: "RC5051" });
    expect((t.errors[0] as Error).message).toMatch(/multicast|side flow/i);
    const runtime = t.ctx.getStore(SUSPENSION_RUNTIME)!;
    expect((await runtime.store.pending()).count).toBe(0);
  });
});

describe("cancellation around the park (RC5054)", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A run cancelled BEFORE its park commits refuses to park
   * @preconditions Route-scope .timeout(25) and a tap that outlives it before the .suspend(); the caller is answered by the deadline
   * @expectedResult The caller receives RC5011 from the timeout; the abandoned run's suspend is refused, so the store stays empty and no resume link exists
   */
  test("abort before the park: nothing is written", async () => {
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .timeout(25)
          .from(direct())
          .process(async (ex) => {
            await sleep(120);
            return ex;
          })
          .suspend({ expect: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    await expect(
      t.client.sendDirect("payout", { go: true }),
    ).rejects.toMatchObject({ rc: "RC5011" });
    // Let the abandoned run settle past its blocking step before inspecting
    // the store.
    await sleep(200);
    const runtime = t.ctx.getStore(SUSPENSION_RUNTIME)!;
    expect((await runtime.store.pending()).count).toBe(0);
  });

  /**
   * @case A run cancelled AFTER its park commits denies the just-created suspension
   * @preconditions Route-scope .timeout(25); the store write itself outlives the deadline, so the abort is observed right after the park; the resume token was minted before the park
   * @expectedResult The caller receives RC5011; the record is finalized denied ("run cancelled"); presenting the token afterwards fails catchably with RC5050 from the settled path
   */
  test("abort after the park: the suspension is denied and the token is dead", async () => {
    const backing = new MemorySuspensionStore();
    const store = storeWith(backing, {
      create: async (record) => {
        await backing.create(record);
        await sleep(120);
      },
    });
    const tokens: string[] = [];
    const ids: string[] = [];
    t = await testContext()
      .with({ suspension: { store, secret: SECRET } })
      .routes([
        craft()
          .id("payout")
          .timeout(25)
          .from(direct())
          .tap((ex) => {
            tokens.push(ex.suspension.token);
            ids.push(ex.suspension.id);
          })
          .suspend({ expect: Approval })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    await expect(
      t.client.sendDirect("payout", { go: true }),
    ).rejects.toMatchObject({ rc: "RC5011" });
    await sleep(250);

    const parked = await backing.pending();
    expect(parked.count).toBe(0);
    const record = await backing.get(ids[0]!);
    expect(record?.status).toBe("denied");
    expect(record?.deniedReason).toBe("run cancelled");

    const resume = t.client.sendDirect("answers", {
      token: tokens[0]!,
      result: { approved: true },
    });
    await expect(resume).rejects.toMatchObject({ rc: "RC5050" });
    await expect(
      t.client.sendDirect("answers", {
        token: tokens[0]!,
        result: { approved: true },
      }),
    ).rejects.toMatchObject({ rc: "RC5050" });
  });
});
