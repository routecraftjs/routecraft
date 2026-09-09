import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import {
  MemoryDeferralStore,
  DEFERRAL_RUNTIME,
  DeferSignal,
  craft,
  direct,
  markDeferCapable,
  noop,
  peekResumeStepState,
  simple,
  type Enricher,
  type Exchange,
} from "../src/index.ts";
import { asDeferred, storeWith, deferring } from "./helpers/deferral.ts";

const Approval = z.object({ approved: z.boolean() });

const SECRET = "reentrant-defer-test-secret-key-0123456789";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A minimal defer-capable enricher: defers on first execution (carrying
 * step-owned state), and on re-entry reports what it was handed back. The
 * agent tier is the shipped implementation of this protocol; this adapter
 * exercises the core seam without any AI machinery.
 */
function deferCapable(): Enricher<unknown, unknown> {
  const adapter: Enricher<unknown, unknown> = {
    fetch: (ex: Exchange<unknown>) => {
      const state = peekResumeStepState(ex);
      if (state !== undefined) {
        return { resumed: true, state, payload: ex.deferral.result };
      }
      throw new DeferSignal({
        schema: Approval,
        ttl: "1h",
        meta: { channel: "finance" },
        stepState: { n: 1 },
      });
    },
  };
  markDeferCapable(adapter);
  return adapter;
}

describe("re-entrant defer sites (defer-capable steps)", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A defer-capable step defers with stepState and re-enters ITSELF on resume
   * @preconditions A .to(capable) step on the main flow; the signal carries stepState { n: 1 }; a resume ingress
   * @expectedResult Execution one replies with the acknowledgment; the resume re-runs the step, which receives the persisted stepState and the raw payload, and the steps after it run once
   */
  test("a capable step defers, and resume re-enters the step with stepState", async () => {
    const sink = spy();
    t = await testContext()
      .with(deferring())
      .routes([
        craft().id("capable").from(direct()).to(deferCapable()).to(sink),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = asDeferred(await t.client.sendDirect("capable", "work"));
    expect(deferred.schema).toBeDefined();
    expect(sink.received).toHaveLength(0);

    const ack = (await t.client.sendDirect("answers", {
      token: deferred.token,
      result: { approved: true },
    })) as { status: string; continuation: { status: string } };
    expect(ack.status).toBe("resumed");
    expect(ack.continuation.status).toBe("completed");

    expect(sink.received).toHaveLength(1);
    expect(sink.received[0]!.body).toEqual({
      resumed: true,
      state: { n: 1 },
      payload: { approved: true },
    });
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case Step-owned state carrying a Date survives deferral and resume intact
   * @preconditions A capable step whose stepState holds a Date; the store owns the one encoding boundary (the deferral does not pre-encode)
   * @expectedResult The resumed step receives a real Date at the deferred instant, not a tagged envelope and not an RC5042 refusal
   */
  test("stepState round-trips a Date through the store", async () => {
    const deferredAt = new Date("2026-08-19T12:00:00.000Z");
    const withDate: Enricher<unknown, unknown> = {
      fetch: (ex: Exchange<unknown>) => {
        const state = peekResumeStepState(ex);
        if (state !== undefined) return { state };
        throw new DeferSignal({ schema: Approval, stepState: { deferredAt } });
      },
    };
    markDeferCapable(withDate);
    const sink = spy();
    t = await testContext()
      .with(deferring())
      .routes([
        craft().id("dated").from(direct()).to(withDate).to(sink),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = asDeferred(await t.client.sendDirect("dated", "work"));
    await t.client.sendDirect("answers", {
      token: deferred.token,
      result: { approved: true },
    });

    expect(sink.received).toHaveLength(1);
    const body = sink.received[0]!.body as { state: { deferredAt: unknown } };
    expect(body.state.deferredAt).toBeInstanceOf(Date);
    expect((body.state.deferredAt as Date).getTime()).toBe(
      deferredAt.getTime(),
    );
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case A step-scope wrapper around a capable step forwards the defer site to the inner host
   * @preconditions .timeout(5000) staged as a step-scope wrapper around .to(capable)
   * @expectedResult The deferral converts inside the step and defers normally: the wrapper observes the outcome, never the raw throw (a retry wrapper would otherwise re-run the deferral)
   */
  test("a wrapped capable step still defers (site forwarded through the wrapper)", async () => {
    const sink = spy();
    t = await testContext()
      .with(deferring())
      .routes([
        craft()
          .id("wrapped")
          .from(direct())
          .timeout(5_000)
          .to(deferCapable())
          .to(sink),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = asDeferred(await t.client.sendDirect("wrapped", "work"));
    expect(deferred.status).toBe("deferred");
    expect(sink.received).toHaveLength(0);
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case A runtime deferral inside a .split() fan-out is refused with RC5051, not deferred
   * @preconditions A capable step under an unbalanced .split(); the route BUILDS (deferability is dynamic), and a child then defers
   * @expectedResult The child's dispatch fails with RC5051 naming the split refusal, and nothing is written to the store
   */
  test("a deferral from inside .split() is refused at runtime with RC5051", async () => {
    t = await testContext()
      .with(deferring())
      .routes([
        craft()
          .id("bulk")
          .from(simple(["one"]))
          .split()
          .to(deferCapable())
          .to(noop()),
      ])
      .build();

    await t.test();
    expect(t.errors.length).toBeGreaterThan(0);
    expect(t.errors[0]).toMatchObject({ rc: "RC5051" });
    expect((t.errors[0] as Error).message).toMatch(/split/i);
    const runtime = t.ctx.getStore(DEFERRAL_RUNTIME)!;
    expect((await runtime.store.pending()).count).toBe(0);
  });

  /**
   * @case A runtime deferral inside a .multicast() path is refused with RC5051, not deferred
   * @preconditions A capable step inside a multicast path; the route builds, the path exchange then defers
   * @expectedResult The path fails with RC5051 naming the side-flow refusal, and nothing is written to the store
   */
  test("a deferral from inside .multicast() is refused at runtime with RC5051", async () => {
    t = await testContext()
      .with(deferring())
      .routes([
        craft()
          .id("fanout")
          .from(simple("work"))
          .multicast((b) => b.to(deferCapable()))
          .to(noop()),
      ])
      .build();

    await t.test();
    expect(t.errors.length).toBeGreaterThan(0);
    expect(t.errors[0]).toMatchObject({ rc: "RC5051" });
    expect((t.errors[0] as Error).message).toMatch(/multicast|side flow/i);
    const runtime = t.ctx.getStore(DEFERRAL_RUNTIME)!;
    expect((await runtime.store.pending()).count).toBe(0);
  });
});

describe("cancellation around the deferral (RC5054)", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A run cancelled BEFORE its deferral commits refuses to defer
   * @preconditions Route-scope .timeout(25) and a tap that outlives it before the .defer(); the caller is answered by the deadline
   * @expectedResult The caller receives RC5011 from the timeout; the abandoned run's defer is refused, so the store stays empty and no resume link exists
   */
  test("abort before the deferral: nothing is written", async () => {
    t = await testContext()
      .with(deferring())
      .routes([
        craft()
          .id("payout")
          .timeout(25)
          .from(direct())
          .process(async (ex) => {
            await sleep(120);
            return ex;
          })
          .defer({ schema: Approval })
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
    const runtime = t.ctx.getStore(DEFERRAL_RUNTIME)!;
    expect((await runtime.store.pending()).count).toBe(0);
  });

  /**
   * @case A run cancelled AFTER its deferral commits denies the just-created deferral
   * @preconditions Route-scope .timeout(25); the store write itself outlives the deadline, so the abort is observed right after the deferral; the resume token was minted before the deferral
   * @expectedResult The caller receives RC5011; the record is finalized denied ("run cancelled"); presenting the token afterwards fails catchably with RC5050 from the settled path
   */
  test("abort after the deferral: the deferral is denied and the token is dead", async () => {
    const backing = new MemoryDeferralStore();
    const store = storeWith(backing, {
      create: async (record) => {
        await backing.create(record);
        await sleep(120);
      },
    });
    const tokens: string[] = [];
    const ids: string[] = [];
    t = await testContext()
      .with({ deferral: { store, secret: SECRET } })
      .routes([
        craft()
          .id("payout")
          .timeout(25)
          .from(direct())
          .tap((ex) => {
            tokens.push(ex.deferral.token);
            ids.push(ex.deferral.id);
          })
          .defer({ schema: Approval })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    await expect(
      t.client.sendDirect("payout", { go: true }),
    ).rejects.toMatchObject({ rc: "RC5011" });
    // The denial finishes on the abandoned run after the injected create
    // delay; poll the record to a terminal status rather than guessing a
    // wall-clock margin a loaded runner can miss.
    const deadline = Date.now() + 2_000;
    let record = await backing.get(ids[0]!);
    while (record?.state === "waiting" && Date.now() < deadline) {
      await sleep(10);
      record = await backing.get(ids[0]!);
    }

    const deferred = await backing.pending();
    expect(deferred.count).toBe(0);
    expect(record?.outcome?.kind).toBe("denied");
    expect(record?.outcome?.reason).toBe("run cancelled");

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
