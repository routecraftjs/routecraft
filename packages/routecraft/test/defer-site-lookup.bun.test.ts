import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import {
  DEFERS,
  MemoryDeferralStore,
  craft,
  direct,
  noop,
  type CraftConfig,
  type DeferringAdapter,
  type Enricher,
  type Exchange,
  type RouteDefinition,
  type StepSignalContext,
} from "../src/index.ts";
import { asDeferred } from "./helpers/deferral.ts";

const SECRET = "defer-site-lookup-test-secret-key-0123456789";

const Approval = z.object({ approved: z.boolean() });

/** One instance per route, so both applications digest the same step. */
function holding(): Enricher<unknown, unknown> & DeferringAdapter {
  return {
    [DEFERS]: () => ({ revival: "this-step" }),
    fetch: (_ex: Exchange<unknown>, ctx?: StepSignalContext) => {
      const revived = ctx?.defer?.revived;
      if (revived !== undefined) return { held: revived.stepState };
      return ctx!.defer!({ stepState: { n: 1 } });
    },
  };
}

describe("a parked exchange finds its defer site by what follows it", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /** Park in one application, then start another on the same store. */
  async function parkThenRestart(
    store: MemoryDeferralStore,
    before: RouteDefinition[],
    after: RouteDefinition[],
    body: unknown,
  ): Promise<string> {
    const shared: CraftConfig = { deferral: { store, secret: SECRET } };
    const first = await testContext().with(shared).routes(before).build();
    await first.startAndWaitReady();
    const deferred = asDeferred(await first.client.sendDirect("work", body));
    await first.stop();

    t = await testContext()
      .with(shared)
      .routes(after, craft().id("answers").from(direct()).resume())
      .build();
    await t.startAndWaitReady();
    return deferred.token;
  }

  /**
   * @case A step is added before the defer point while an exchange is parked
   * @preconditions The exchange parks at .defer(); a second application runs the same route with one more step ahead of the defer, sharing the store
   * @expectedResult The resume is accepted and the unchanged continuation runs once, because nothing the approval covered moved
   */
  test("a step added before the defer point does not refuse the resume", async () => {
    const sink = spy();
    const pay = () => ({ paid: true });

    const token = await parkThenRestart(
      new MemoryDeferralStore(),
      craft()
        .id("work")
        .from(direct())
        .defer({ input: Approval })
        .transform(pay)
        .to(sink)
        .build(),
      craft()
        .id("work")
        .from(direct())
        .tap(noop())
        .defer({ input: Approval })
        .transform(pay)
        .to(sink)
        .build(),
      { amount: 1 },
    );

    const ack = (await t!.client.sendDirect("answers", {
      token,
      input: { approved: true },
    })) as { status: string };

    expect(ack.status).toBe("resumed");
    expect(sink.received).toHaveLength(1);
    expect(sink.received[0]!.body).toEqual({ paid: true });
    expect(t!.errors).toHaveLength(0);
  });

  /**
   * @case A step is removed before the defer point while an exchange is parked
   * @preconditions The exchange parks at a .defer() that follows a tap; a second application runs the route without the tap, sharing the store
   * @expectedResult The resume is accepted and the continuation runs once
   */
  test("a step removed before the defer point does not refuse the resume", async () => {
    const sink = spy();
    const token = await parkThenRestart(
      new MemoryDeferralStore(),
      craft()
        .id("work")
        .from(direct())
        .tap(noop())
        .defer({ input: Approval })
        .to(sink)
        .build(),
      craft()
        .id("work")
        .from(direct())
        .defer({ input: Approval })
        .to(sink)
        .build(),
      { amount: 1 },
    );

    const ack = (await t!.client.sendDirect("answers", {
      token,
      input: { approved: true },
    })) as { status: string };

    expect(ack.status).toBe("resumed");
    expect(sink.received).toHaveLength(1);
    expect(t!.errors).toHaveLength(0);
  });

  /**
   * @case Two defer sites share one continuation and the route is unchanged
   * @preconditions A .defer() with no input directly ahead of a step that defers itself with no input: both sites are followed by the same steps
   * @expectedResult The first resume continues from the .defer() and parks again at the step; the second re-enters the step with its state, so each record resolved to its own site by position
   */
  test("two sites with one continuation resolve by position", async () => {
    const sink = spy();
    const hold = holding();
    t = await testContext()
      .with({ deferral: { store: new MemoryDeferralStore(), secret: SECRET } })
      .routes([
        craft().id("work").from(direct()).defer().to(hold).to(sink),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const first = asDeferred(await t.client.sendDirect("work", "go"));
    const second = (await t.client.sendDirect("answers", {
      token: first.token,
      input: undefined,
    })) as { continuation: { status: string } };
    expect(second.continuation.status).toBe("deferred");
    expect(sink.received).toHaveLength(0);

    const parked = await t.ctx.continuations.list({ limit: 10 });
    const waiting = parked.find((record) => record.state === "waiting")!;
    await t.client.sendDirect("answers", {
      token: t.ctx.continuations.mintToken(waiting.id),
      input: undefined,
    });

    expect(sink.received).toHaveLength(1);
    expect(sink.received[0]!.body).toEqual({ held: { n: 1 } });
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case Two defer sites share one continuation and both moved while an exchange was parked
   * @preconditions The exchange parks at the .defer() of the route above; a second application adds a step ahead of both sites, sharing the store
   * @expectedResult The resume is refused with RC5048 saying the site cannot be told apart, before any continuation step runs
   */
  test("two moved sites with one continuation are refused as ambiguous", async () => {
    const sink = spy();
    const hold = holding();
    const token = await parkThenRestart(
      new MemoryDeferralStore(),
      craft().id("work").from(direct()).defer().to(hold).to(sink).build(),
      craft()
        .id("work")
        .from(direct())
        .tap(noop())
        .defer()
        .to(hold)
        .to(sink)
        .build(),
      "go",
    );

    const refused = t!.client.sendDirect("answers", {
      token,
      input: undefined,
    });
    await expect(refused).rejects.toMatchObject({ rc: "RC5048" });
    await expect(refused).rejects.toThrow(/cannot be told apart/);
    expect(sink.received).toHaveLength(0);
  });
});
