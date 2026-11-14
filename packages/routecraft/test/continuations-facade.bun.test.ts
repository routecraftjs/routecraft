import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import {
  DEFERS,
  MemoryDeferralStore,
  applicationOf,
  continuationsOf,
  craft,
  definePlugin,
  direct,
  noop,
  type ApplicationKey,
  type Continuations,
  type ContinuationsView,
  type DeferringAdapter,
  type Enricher,
  type Exchange,
  type StepSignalContext,
} from "../src/index.ts";
import { asDeferred } from "./helpers/deferral.ts";

const SECRET = "continuations-facade-test-secret-0123456789";
const Approval = z.object({ approved: z.boolean() });
const deferredAt = new Date("2026-08-19T12:00:00.000Z");

/** Defers with a `Date` in its step state and its meta, and reports the state it is revived with. */
function holds(): Enricher<unknown, unknown> & DeferringAdapter {
  return {
    [DEFERS]: () => ({ revival: "this-step" }),
    fetch: (_ex: Exchange<unknown>, ctx?: StepSignalContext) => {
      const revived = ctx?.defer?.revived;
      if (revived !== undefined) return { state: revived.stepState };
      return ctx!.defer!({
        input: Approval,
        stepState: { deferredAt, n: 1 },
        meta: { asked: deferredAt },
      });
    },
  };
}

describe("continuations: the read view and the acts", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  async function build(extra: Parameters<typeof definePlugin>[0][] = []) {
    const store = new MemoryDeferralStore();
    const sink = spy();
    const views: ContinuationsView[] = [];
    const keys: Array<ApplicationKey | undefined> = [];
    t = await testContext()
      .with({
        deferral: { store, secret: SECRET },
        plugins: extra.map((plugin) => definePlugin(plugin)),
      })
      .routes([
        craft()
          .id("held")
          .from(direct())
          .tap((ex) => {
            views.push(continuationsOf(ex));
            keys.push(applicationOf(ex));
          })
          .to(holds())
          .to(sink),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();
    const park = async () =>
      asDeferred(await t!.client.sendDirect("held", { go: true }));
    return { store, sink, views, keys, park };
  }

  /**
   * @case A record read through the view carries its free-form slots as the step handed them over
   * @preconditions A step that defers with a Date in stepState and in meta; the store holds both as envelopes
   * @expectedResult get() returns real Dates in both slots, while the store's own record holds the JSON envelope, so a store never has to know the codec
   */
  test("get() revives stepState and meta; the store holds plain JSON", async () => {
    const { store, park } = await build();
    const deferred = await park();

    const record = await t!.ctx.continuations.get(deferred.deferralId);
    const state = record?.stepState as { deferredAt: unknown; n: number };
    expect(state.deferredAt).toBeInstanceOf(Date);
    expect((state.deferredAt as Date).getTime()).toBe(deferredAt.getTime());
    expect((record?.meta as { asked: unknown }).asked).toBeInstanceOf(Date);

    const raw = await store.get(deferred.deferralId);
    expect(JSON.parse(JSON.stringify(raw?.stepState))).toEqual(raw?.stepState);
    expect(
      (raw?.stepState as { deferredAt: unknown }).deferredAt,
    ).not.toBeInstanceOf(Date);
  });

  /**
   * @case Route code reads any record of its application and holds no act
   * @preconditions continuationsOf(ex) taken inside a route, then a deferral parked by that route
   * @expectedResult The view lists and reads the record and verifies its token to the deferral id, a token nobody signed verifies to undefined, and the view has no resume, sweep, mintToken or rewriteStepState member
   */
  test("continuationsOf(ex) reads every record and carries no act", async () => {
    const { views, park } = await build();
    const deferred = await park();
    const view = views[0]!;

    expect(view.available).toBe(true);
    expect((await view.get(deferred.deferralId))?.routeId).toBe("held");
    expect((await view.list({ limit: 10 })).map((d) => d.id)).toContain(
      deferred.deferralId,
    );
    expect(view.verifyToken(deferred.token)).toBe(deferred.deferralId);
    expect(view.verifyToken("not-a-token")).toBeUndefined();
    for (const act of ["resume", "sweep", "mintToken", "rewriteStepState"]) {
      expect(act in view).toBe(false);
    }
  });

  /**
   * @case A token minted through the facade resumes the record
   * @preconditions A parked exchange; a second token minted with context.continuations.mintToken(id)
   * @expectedResult Presenting the minted token at the resume door runs the continuation once
   */
  test("mintToken() mints a token the resume door accepts", async () => {
    const { sink, park } = await build();
    const deferred = await park();

    const token = t!.ctx.continuations.mintToken(deferred.deferralId);
    expect(token).not.toBe("");
    await t!.client.sendDirect("answers", {
      token,
      input: { approved: true },
    });
    expect(sink.received).toHaveLength(1);
  });

  /**
   * @case rewriteStepState hands the rewrite the live state and stores the replacement encoded
   * @preconditions A parked exchange whose stepState holds a Date
   * @expectedResult The rewrite receives a Date, the swap is won, and the resumed step is handed the replacement with its Date intact
   */
  test("rewriteStepState() round-trips through the kernel's codec", async () => {
    const { sink, park } = await build();
    const deferred = await park();
    const later = new Date("2026-08-20T12:00:00.000Z");

    let seen: unknown;
    const cas = await t!.ctx.continuations.rewriteStepState(
      deferred.deferralId,
      (state) => {
        seen = (state as { deferredAt: unknown }).deferredAt;
        return { deferredAt: later, n: 2 };
      },
    );
    expect(seen).toBeInstanceOf(Date);
    expect(cas.won).toBe(true);

    await t!.client.sendDirect("answers", {
      token: deferred.token,
      input: { approved: true },
    });
    const body = sink.received[0]!.body as {
      state: { deferredAt: Date; n: number };
    };
    expect(body.state.n).toBe(2);
    expect(body.state.deferredAt.getTime()).toBe(later.getTime());
  });

  /**
   * @case A replacement that cannot be stored is refused before the store sees it
   * @preconditions A parked exchange and a rewrite returning a circular structure
   * @expectedResult RC5042, and the stored step state is what it was, on any backend, because the rule lives at the kernel's edge
   */
  test("rewriteStepState() refuses an unpersistable replacement with RC5042", async () => {
    const { store, park } = await build();
    const deferred = await park();
    const before = (await store.get(deferred.deferralId))?.stepState;
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;

    await expect(
      t!.ctx.continuations.rewriteStepState(deferred.deferralId, () => cycle),
    ).rejects.toMatchObject({ rc: "RC5042" });
    expect((await store.get(deferred.deferralId))?.stepState).toEqual(before);
  });

  /**
   * @case A record that already resumed is not rewritten
   * @preconditions A parked exchange, resumed, then a rewrite attempted
   * @expectedResult won: false with the resumed record, and the rewrite function is never called
   */
  test("rewriteStepState() does not call the rewrite on a settled record", async () => {
    const { park } = await build();
    const deferred = await park();
    await t!.client.sendDirect("answers", {
      token: deferred.token,
      input: { approved: true },
    });

    let called = false;
    const cas = await t!.ctx.continuations.rewriteStepState(
      deferred.deferralId,
      (state) => {
        called = true;
        return state;
      },
    );
    expect(cas.won).toBe(false);
    expect(cas.deferral?.outcome?.kind).toBe("resumed");
    expect(called).toBe(false);
  });

  /**
   * @case A plugin's application key is the one its exchanges report
   * @preconditions A plugin capturing c.application and c.continuations in bind; a route reading applicationOf(ex)
   * @expectedResult The two keys are the same object, it has no members, and the plugin's facade resumes a record with no door
   */
  test("c.application matches applicationOf(ex), and c.continuations acts", async () => {
    let key: ApplicationKey | undefined;
    let facade: Continuations | undefined;
    const { keys, sink, park } = await build([
      {
        id: "test.holder",
        bind(c) {
          key = c.application;
          facade = c.continuations;
        },
      },
    ]);
    const deferred = await park();

    expect(key).toBeDefined();
    expect(keys[0]).toBe(key);
    expect(Object.keys(key!)).toHaveLength(0);
    const ack = await facade!.resume({
      token: deferred.token,
      input: { approved: true },
    });
    expect(ack.status).toBe("resumed");
    expect(sink.received).toHaveLength(1);
  });

  /**
   * @case Two applications in one process have different keys
   * @preconditions Two test contexts, each with a route reading applicationOf(ex)
   * @expectedResult The keys differ, so a plugin module keying its state by them keeps the two apart
   */
  test("two applications have distinct keys", async () => {
    const seen: Array<ApplicationKey | undefined> = [];
    const make = () =>
      testContext()
        .routes([
          craft()
            .id("probe")
            .from(direct())
            .tap((ex) => {
              seen.push(applicationOf(ex));
            })
            .to(noop()),
        ])
        .build();
    t = await make();
    const other = await make();
    try {
      await t.startAndWaitReady();
      await other.startAndWaitReady();
      await t.client.sendDirect("probe", {});
      await other.client.sendDirect("probe", {});
      await t.drain();
      await other.drain();
      expect(seen[0]).toBeDefined();
      expect(seen[1]).toBeDefined();
      expect(seen[0]).not.toBe(seen[1]);
    } finally {
      await other.stop();
    }
  });

  /**
   * @case Without a continuations provider the view says so and reads refuse
   * @preconditions A context with no deferral plugin
   * @expectedResult available is false, verifyToken answers undefined, get() rejects with RC5052 and sweep() resolves 0
   */
  test("an application without continuations reports itself unavailable", async () => {
    t = await testContext()
      .routes([craft().id("plain").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();
    const facade = t.ctx.continuations;

    expect(facade.available).toBe(false);
    expect(facade.verifyToken("anything")).toBeUndefined();
    await expect(facade.get("nope")).rejects.toMatchObject({ rc: "RC5052" });
    expect(await facade.sweep()).toBe(0);
  });

  /**
   * @case Work handed to c.execution.trackTask is waited for by drain
   * @preconditions A plugin tracking a task that settles after 40ms, once for a named route and once for none
   * @expectedResult drain() resolves only after both settled, and a rejection is logged rather than thrown
   */
  test("execution.trackTask() is drained", async () => {
    let track:
      | ((task: Promise<unknown>, options?: { route?: string }) => void)
      | undefined;
    await build([
      {
        id: "test.tracker",
        bind(c) {
          track = (task, options) => c.execution.trackTask(task, options);
        },
      },
    ]);
    const done: string[] = [];
    const later = (name: string) =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          done.push(name);
          resolve();
        }, 40),
      );
    track!(later("routed"), { route: "held" });
    track!(later("loose"));
    track!(Promise.reject(new Error("boom")));

    await t!.drain();
    expect(done.sort()).toEqual(["loose", "routed"]);
    expect(
      t!.contextLogger.error.mock.calls.some(
        (call) => call[1] === "Background task failed",
      ),
    ).toBe(true);
  });

  /**
   * @case Work tracked for no route is waited for by stop
   * @preconditions A plugin tracking a task that settles after 40ms, naming no route, and then the context is stopped
   * @expectedResult stop() resolves only after the task settled, unforced
   */
  test("execution.trackTask() holds stop() open", async () => {
    let track: ((task: Promise<unknown>) => void) | undefined;
    await build([
      {
        id: "test.tracker",
        bind(c) {
          track = (task) => c.execution.trackTask(task);
        },
      },
    ]);
    let settled = false;
    track!(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          settled = true;
          resolve();
        }, 40),
      ),
    );

    const outcome = await t!.ctx.stop();
    expect(settled).toBe(true);
    expect(outcome.forced).toBe(false);
  });
});
