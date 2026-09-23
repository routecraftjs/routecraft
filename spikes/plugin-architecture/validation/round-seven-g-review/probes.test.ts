import { test, expect } from "bun:test";
import {
  application,
  infrastructure,
  operations,
  resilience,
  deferralPlugin,
  sqlite,
  principals,
  auth,
  withPrincipal,
  manual,
  CONTINUATIONS,
  allRuns,
  durableStore,
  SqliteRecords,
  fingerprint,
  continueWith,
  encode,
  decode,
  point,
  type ContinuationStore,
  type StepOutcome,
} from "../../src/v2/index.ts";
import { encodePersistable } from "../../../../packages/routecraft/src/deferral/serialize.ts";

const CHECKPOINT: unique symbol = Symbol("review-checkpoint");
declare module "../../src/v2/contracts.ts" {
  interface HandlerPoints {
    reviewCheckpoint: {
      readonly owner: typeof CHECKPOINT;
      readonly refuse: false;
      readonly defer: true;
    };
  }
}

// Characterizations of the unchanged reviewed head, not acceptance assertions.
const latch = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
};
const parkErrors = infrastructure({
  id: "review.parker",
  bind(c) {
    c.contribute({
      kind: "handler",
      id: "park",
      point: "error",
      survival: allRuns,
      mayDefer: true,
      handle: () => ({
        kind: "defer",
        request: { name: "fix", reason: "review" },
      }),
    });
  },
});
function vendor(
  patch: (inner: ContinuationStore) => Partial<ContinuationStore>,
) {
  const db = new SqliteRecords(":memory:");
  const inner = durableStore(db);
  const store = { ...inner, ...patch(inner) };
  const plugin = infrastructure({
    id: "review.store",
    provides: [CONTINUATIONS],
    bind(c) {
      c.provide(CONTINUATIONS, store);
    },
  });
  return { plugin, store, close: () => db.close() };
}
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
    return "no failure";
  } catch (e) {
    return String(e);
  }
};

for (const errorPath of [false, true]) {
  /** @case R1
   * @preconditions Ordinary or error-path park blocked inside the store write.
   * @expectedResult Characterize cancellation leaving a waiting record and a deferred result. */
  test(`R1: cancellation during durable create leaves a live ${errorPath ? "error" : "ordinary"} park`, async () => {
    const entered = latch(),
      release = latch(),
      controller = new AbortController();
    let savedId = "",
      notified = 0;
    const v = vendor((inner) => ({
      async create(id, value) {
        savedId = id;
        entered.release();
        await release.promise;
        return inner.create(id, value);
      },
    }));
    const app = application([operations, v.plugin, parkErrors] as const);
    await app.start([
      app
        .route("r")
        .from(manual)
        .step("park", (ex): StepOutcome => {
          if (errorPath) throw Error("failed step");
          return {
            kind: "defer",
            exchange: ex,
            request: {
              name: "x",
              reason: "x",
              notify: () => {
                notified++;
              },
            },
          };
        })
        .build(),
    ]);
    const delivery = app.runtime.deliver("r", 0, {}, controller.signal);
    await entered.promise;
    controller.abort(Error("caller cancelled"));
    release.release();
    expect((await delivery).status).toBe("deferred");
    expect((await v.store.get(savedId))?.state).toBe("waiting");
    expect(notified).toBe(errorPath ? 0 : 1);
    await app.stop();
    v.close();
  });
}

/** @case R2
 * @preconditions The controlled fixture below runs against the unchanged reviewed source.
 * @expectedResult Characterize: abort does not bound notification after a committed park. */
test("R2: abort does not bound notification after a committed park", async () => {
  const entered = latch(),
    release = latch(),
    controller = new AbortController();
  let id = "",
    finished = false;
  const v = vendor(() => ({}));
  const app = application([v.plugin]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .step("park", (ex) => ({
        kind: "defer",
        exchange: ex,
        request: {
          name: "x",
          reason: "x",
          notify: async (value) => {
            id = value;
            entered.release();
            await release.promise;
          },
        },
      }))
      .build(),
  ]);
  const work = app.runtime
    .deliver("r", 0, {}, controller.signal)
    .finally(() => {
      finished = true;
    });
  await entered.promise;
  controller.abort();
  await new Promise((r) => setTimeout(r, 20));
  expect(finished).toBe(false);
  expect((await v.store.get(id))?.state).toBe("waiting");
  release.release();
  expect((await work).status).toBe("deferred");
  await app.stop();
  v.close();
});

/** @case R3
 * @preconditions The controlled fixture below runs against the unchanged reviewed source.
 * @expectedResult Characterize: grant comparison admits a comma-colliding permanent grant set. */
test("R3: grant comparison admits a comma-colliding permanent grant set", async () => {
  const app = application([
    operations,
    deferralPlugin({ interval: 0 }),
    sqlite(":memory:"),
    principals,
    auth,
    parkErrors,
  ]);
  await app.start([
    app
      .route("r")
      .authorize("admin")
      .resumable({
        authorize: () => true,
        elevate: () =>
          withPrincipal(
            {},
            { subject: "alice", grants: ["admin", "read"], lent: [] },
          ),
      })
      .from(manual)
      .transform((_, ex) => ex.auth.principal?.grants)
      .build(),
  ]);
  const id = (
    await app.runtime.deliver(
      "r",
      0,
      withPrincipal({}, { subject: "alice", grants: ["admin,read"], lent: [] }),
    )
  ).deferrals[0]!;
  const result = await app.runtime.resume(id);
  expect(result.status).toBe("completed");
  expect(result.exchanges[0]?.body).toEqual(["admin", "read"]);
  await app.stop();
});

/** @case R4
 * @preconditions The controlled fixture below runs against the unchanged reviewed source.
 * @expectedResult Characterize: retry succeeds but tracked failed attempt turns the route into failure. */
test("R4: retry succeeds but tracked failed attempt turns the route into failure", async () => {
  let attempts = 0,
    effects = 0;
  const app = application([resilience]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .retry(2)
      .timeout(1000)
      .step("flaky", (ex) => {
        if (++attempts === 1) throw Error("transient");
        effects++;
        return continueWith(ex);
      })
      .build(),
  ]);
  expect(await failure(app.runtime.deliver("r", 0))).toContain("transient");
  expect(attempts).toBe(2);
  expect(effects).toBe(1);
  await app.stop();
});

/** @case R5
 * @preconditions The controlled fixture below runs against the unchanged reviewed source.
 * @expectedResult Characterize: step-state replacement wins while the door waits but resume executes old state. */
test("R5: step-state replacement wins while the door waits but resume executes old state", async () => {
  const entered = latch(),
    release = latch();
  const app = application([
    deferralPlugin({ interval: 0 }),
    sqlite(":memory:"),
    principals,
    auth,
  ]);
  await app.start([
    app
      .route("r")
      .resumable({
        authorize: async () => {
          entered.release();
          await release.promise;
          return true;
        },
      })
      .from(manual)
      .step("park", (ex, ctx): StepOutcome =>
        ctx.kind === "resume"
          ? { kind: "continue", exchange: { ...ex, body: ctx.stepState } }
          : {
              kind: "defer",
              exchange: ex,
              request: { name: "x", reason: "x", reenter: true, state: "old" },
            },
      )
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", 0)).deferrals[0]!;
  const store = app.host.service(CONTINUATIONS);
  const work = app.runtime.resume(id);
  await entered.promise;
  expect(await store.replaceStepState(id, fingerprint("old"), "new")).toBe(
    "won",
  );
  release.release();
  expect((await work).exchanges[0]?.body).toBe("old");
  expect((await store.get(id))?.continuation.stepState).toBe("new");
  await app.stop();
});

/** @case R6
 * @preconditions The controlled fixture below runs against the unchanged reviewed source.
 * @expectedResult Characterize: a cross-route dispatch leaks step state to an unrelated same-id step. */
test("R6: a cross-route dispatch leaks step state to an unrelated same-id step", async () => {
  const app = application([
    deferralPlugin({ interval: 0 }),
    sqlite(":memory:"),
  ]);
  const target = app
    .route("target")
    .from(manual)
    .step("park", (ex, ctx) => ({
      kind: "continue",
      exchange: { ...ex, body: ctx.stepState },
    }))
    .build();
  const source = app
    .route("source")
    .from(manual)
    .step("park", async (ex, ctx): Promise<StepOutcome> => {
      if (ctx.kind !== "resume")
        return {
          kind: "defer",
          exchange: ex,
          request: {
            name: "x",
            reason: "x",
            reenter: true,
            state: "private-state",
          },
        };
      const answer = await ctx.dispatch("target", ex);
      return {
        kind: "continue",
        exchange: { ...ex, body: answer.exchanges[0]?.body },
      };
    })
    .build();
  await app.start([source, target]);
  const id = (await app.runtime.deliver("source", 0)).deferrals[0]!;
  expect((await app.runtime.resume(id)).exchanges[0]?.body).toBe(
    "private-state",
  );
  await app.stop();
});

/** @case R7
 * @preconditions The controlled fixture below runs against the unchanged reviewed source.
 * @expectedResult Characterize: stop during the swap permits suffix execution after resources are disposed. */
test("R7: stop during the swap permits suffix execution after resources are disposed", async () => {
  const entered = latch(),
    release = latch();
  let disposed = false,
    ranAfterDispose = false;
  const v = vendor((inner) => ({
    async markResumed(id, at, by) {
      entered.release();
      await release.promise;
      return inner.markResumed(id, at, by);
    },
  }));
  const resource = infrastructure({
    id: "review.resource",
    bind(c) {
      c.onDispose(() => {
        disposed = true;
      });
    },
  });
  const app = application([v.plugin, resource]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .step("park", (ex) => ({
        kind: "defer",
        exchange: ex,
        request: { name: "x", reason: "x" },
      }))
      .map(() => {
        ranAfterDispose = disposed;
        return "ran";
      })
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", 0)).deferrals[0]!;
  const work = app.runtime.resume(id);
  await entered.promise;
  expect(await failure(app.runtime.stop(5))).toContain("DRAIN_TIMEOUT");
  expect(disposed).toBe(true);
  release.release();
  expect((await work).status).toBe("completed");
  expect(ranAfterDispose).toBe(true);
  v.close();
});

/** @case R8
 * @preconditions The controlled fixture below runs against the unchanged reviewed source.
 * @expectedResult Characterize: reusing one deferral descriptor lets stopping context A cancel context B's timer. */
test("R8: reusing one deferral descriptor lets stopping context A cancel context B's timer", async () => {
  // Observe timer ownership without leaving the orphan timer throwing after stop.
  const originalSet = globalThis.setInterval,
    originalClear = globalThis.clearInterval;
  const handles: object[] = [],
    cleared: object[] = [];
  globalThis.setInterval = (() => {
    const handle = { unref() {} };
    handles.push(handle);
    return handle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle: object) => {
    cleared.push(handle);
  }) as typeof clearInterval;
  const shared = deferralPlugin({ interval: 10 });
  const a = application([shared, sqlite(":memory:")]);
  const b = application([shared, sqlite(":memory:")]);
  try {
    await a.start([a.route("r").from(manual).defer("x").build()]);
    await b.start([b.route("r").from(manual).defer("x", -1).build()]);
    expect(handles.length).toBe(2);
    await a.stop();
    expect(cleared).toEqual([handles[1]!]);
    const id = (await b.runtime.deliver("r", 0)).deferrals[0]!;
    expect((await b.host.service(CONTINUATIONS).get(id))?.state).toBe(
      "waiting",
    );
    expect((await b.runtime.sweep()).retired).toBe(1);
    await b.stop();
    expect(cleared).toEqual([handles[1]!]);
  } finally {
    globalThis.setInterval = originalSet;
    globalThis.clearInterval = originalClear;
  }
});

/** @case R9
 * @preconditions The controlled fixture below runs against the unchanged reviewed source.
 * @expectedResult Characterize: decorated admission state is lost when a later admission handler refuses. */
test("R9: decorated admission state is lost when a later admission handler refuses", async () => {
  const decorator = infrastructure({
    id: "aaa.decorate",
    bind(c) {
      c.contribute({
        kind: "handler",
        id: "decorate",
        point: "admission",
        survival: allRuns,
        handle: (ex) => ({
          kind: "allow",
          exchange: {
            ...ex,
            body: "decorated",
            headers: { ...ex.headers, provenance: "added" },
          },
        }),
      });
    },
  });
  const refuser = infrastructure({
    id: "bbb.refuse",
    bind(c) {
      c.contribute({
        kind: "handler",
        id: "refuse",
        point: "admission",
        survival: allRuns,
        handle: (ex) => {
          expect(ex.body).toBe("decorated");
          return { kind: "refuse", reason: "wait" };
        },
      });
    },
  });
  const app = application([
    decorator,
    refuser,
    parkErrors,
    deferralPlugin({ interval: 0 }),
    sqlite(":memory:"),
  ]);
  await app.start([app.route("r").from(manual).build()]);
  const id = (await app.runtime.deliver("r", "original")).deferrals[0]!;
  const saved = (await app.host.service(CONTINUATIONS).get(id))!.continuation
    .exchange;
  expect(saved.body).toBe("original");
  expect(saved.headers["provenance"]).toBeUndefined();
  await app.stop();
});

/** @case R10
 * @preconditions The controlled fixture below runs against the unchanged reviewed source.
 * @expectedResult Characterize: an open point can advertise defer but invoke discards its request. */
test("R10: an open point can advertise defer but invoke discards its request", async () => {
  const custom = infrastructure({
    id: "review.checkpoint",
    points: [point("reviewCheckpoint", CHECKPOINT, false, true)],
    bind(c) {
      c.contribute({
        kind: "handler",
        id: "wait",
        point: "reviewCheckpoint",
        survival: allRuns,
        mayDefer: true,
        handle: () => ({
          kind: "defer",
          request: { name: "checkpoint", reason: "review" },
        }),
      });
    },
  });
  const app = application([
    custom,
    deferralPlugin({ interval: 0 }),
    sqlite(":memory:"),
  ]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .step("invoke", async (ex, ctx) => {
        const result = await ctx.invoke("reviewCheckpoint", ex);
        return { kind: "continue", exchange: { ...ex, body: result } };
      })
      .build(),
  ]);
  const result = await app.runtime.deliver("r", 0);
  expect(result.status).toBe("completed");
  expect(result.exchanges[0]?.body).toBeNull();
  expect(await app.host.service(CONTINUATIONS).pending()).toEqual({ count: 0 });
  await app.stop();
});

/** @case R11
 * @preconditions The controlled fixture below runs against the unchanged reviewed source.
 * @expectedResult Characterize: array holes keep backend-dependent shape unlike the shipped codec. */
test("R11: array holes keep backend-dependent shape unlike the shipped codec", () => {
  const value = new Array(1);
  const encoded = encode(value, "review") as unknown[];
  expect(0 in (decode(structuredClone(encoded)) as unknown[])).toBe(false);
  expect(0 in (decode(JSON.parse(JSON.stringify(encoded))) as unknown[])).toBe(
    true,
  );
  expect(encodePersistable(value, "review")).toEqual([null]);
  expect(0 in (encodePersistable(value, "review") as unknown[])).toBe(true);
});

/** @case R11
 * @preconditions The controlled fixture below runs against the unchanged reviewed source.
 * @expectedResult Characterize: a numeric-looking non-index array property is silently lost. */
test("R11: a numeric-looking non-index array property is silently lost", () => {
  const value = [1];
  Object.defineProperty(value, "4294967295", {
    value: "must not disappear",
    enumerable: true,
  });
  expect(encode(value, "review")).toEqual([1]);
  expect(() => encodePersistable(value, "review")).toThrow("named property");
});

/** @case R12
 * @preconditions The controlled fixture below runs against the unchanged reviewed source.
 * @expectedResult Characterize: removing the deferred route removes its door policy before disclosure. */
test("R12: removing the deferred route removes its door policy before disclosure", async () => {
  const v = vendor(() => ({}));
  const first = application([v.plugin, auth, principals]);
  await first.start([
    first
      .route("protected")
      .resumable({ authorize: () => false })
      .from(manual)
      .step("park", (ex) => ({
        kind: "defer",
        exchange: ex,
        request: { name: "x", reason: "x" },
      }))
      .build(),
  ]);
  const id = (await first.runtime.deliver("protected", 0)).deferrals[0]!;
  expect((await first.runtime.resume(id)).status).toBe("refused");
  await first.stop();
  const second = application([v.plugin, auth, principals]);
  await second.start([]);
  expect(await failure(second.runtime.resume(id))).toContain(
    "UNKNOWN_ROUTE: protected",
  );
  expect((await v.store.get(id))?.state).toBe("waiting");
  await second.stop();
  v.close();
});

/** @case R13
 * @preconditions An observer records the terminal event of an ordinary durable park.
 * @expectedResult The same event name is emitted twice with different id meanings. */
test("R13: an ordinary park emits two deferred terminal events", async () => {
  const deferred: unknown[] = [];
  const observer = infrastructure({
    id: "review.observer",
    bind(c) {
      c.observe((event) => {
        if (event.name === "exchange:deferred") deferred.push(event.data);
      });
    },
  });
  const app = application([
    observer,
    deferralPlugin({ interval: 0 }),
    sqlite(":memory:"),
  ]);
  await app.start([app.route("r").from(manual).defer("x").build()]);
  const id = (await app.runtime.deliver("r", 0)).deferrals[0]!;
  expect(deferred).toEqual([
    { id, route: "r" },
    { id: id.slice(0, -2), route: "r" },
  ]);
  await app.stop();
});

/** @case R14
 * @preconditions A stored body contains a corrupt date envelope; header decoding still succeeds.
 * @expectedResult Revival throws after the claim without recording the failure. */
test("R14: corrupt-body revival after CAS leaves false crash residue", async () => {
  let corrupt = false;
  const v = vendor((inner) => ({
    async get(id) {
      const saved = await inner.get(id);
      return corrupt && saved
        ? {
            ...saved,
            continuation: {
              ...saved.continuation,
              exchange: {
                ...saved.continuation.exchange,
                body: { $date: "not-a-date" },
              },
            },
          }
        : saved;
    },
  }));
  const app = application([v.plugin]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .step("park", (ex) => ({
        kind: "defer",
        exchange: ex,
        request: { name: "x", reason: "x" },
      }))
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", 0)).deferrals[0]!;
  corrupt = true;
  expect(await failure(app.runtime.resume(id))).toContain("CORRUPT_ENVELOPE");
  expect((await v.store.get(id))?.state).toBe("resumed");
  expect((await v.store.get(id))?.outcome).toBeUndefined();
  expect(await v.store.resumedWithoutOutcome()).toEqual([id]);
  await app.stop();
  v.close();
});
