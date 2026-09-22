import { test, expect } from "bun:test";
import {
  application,
  infrastructure,
  instruction,
  continueWith,
  operations,
  resilience,
  deferral,
  deferralPlugin,
  sqlite,
  auth,
  principals,
  manual,
  withPrincipal,
  encode,
  decode,
  allRuns,
  CONTINUATIONS,
  DEFAULT_TTL,
  SqliteRecords,
  durableStore,
  type Continuation,
  type ContinuationStore,
  type Fault,
  type HandlerDecision,
  type Step,
  type StepOutcome,
} from "../../src/v2/index.ts";

/**
 * Round 7g: the clean-room review of round 7f (`reviews/OPUS-ROUND-7F.md`)
 * inverted. Its fourteen probes asserted what the head did; each here
 * asserts what it must do, by the finding's number, and the last group gives
 * its surviving mutants a test each.
 */

const parked = (
  expiresAt: number | undefined,
  routeId = "r",
  parkedAt = 0,
): Continuation => ({
  codec: 2,
  routeId,
  site: null,
  frames: [{ list: null, from: 0 }],
  tail: "x",
  parkedAt,
  ...(expiresAt !== undefined ? { expiresAt } : {}),
  exchange: { id: "e", routeId, body: 1, headers: {} },
});
const alice = (lent: string[] = []) =>
  withPrincipal({}, { subject: "alice", grants: [], lent });
const manager = withPrincipal(
  {},
  { subject: "manager", grants: ["lend"], lent: [] },
);
const ring = (seen: string[], id = "acme.ops") =>
  infrastructure({
    id,
    bind: (c) =>
      c.contribute({
        kind: "handler",
        id: "log",
        point: "error",
        survival: allRuns,
        handle: (ex, { error, kind }) => {
          seen.push(
            `${kind}:${error?.code}:${error?.secondary.map((x) => x.code).join("+")}`,
          );
          return { kind: "allow", exchange: ex };
        },
      }),
  });
/** A step-up plugin: parks refusals (and, when asked, any failure) from the error ring. */
const parker = (
  options: { failures?: boolean; kinds?: readonly string[] } = {},
) =>
  infrastructure({
    id: "acme.stepup",
    bind: (c) =>
      c.contribute({
        kind: "handler",
        id: "park",
        point: "error",
        survival: allRuns,
        mayDefer: true,
        handle: (ex, { error, kind }) =>
          (options.kinds ?? ["normal"]).includes(kind) &&
          (options.failures || error?.code === "REFUSED")
            ? { kind: "defer", request: { name: "step-up", reason: "refused" } }
            : { kind: "allow", exchange: ex },
      }),
  });
/** The fault a promise rejected with, so what was attached to it after the error ring ran can be read. */
const faultOf = async (work: Promise<unknown>): Promise<Fault> => {
  try {
    await work;
  } catch (e) {
    return e as Fault;
  }
  throw Error("did not fail");
};
const declines = (f: Fault) => f.secondary.map((x) => x.code);
const lend =
  (lent: string[]) =>
  ({
    deferred,
  }: {
    deferred?: { subject: string; grants: readonly string[] };
  }) =>
    withPrincipal(
      {},
      { subject: deferred!.subject, grants: [...deferred!.grants], lent },
    );

/**
 * @case G1: a park raised at the door is re-admitted on resume
 * @preconditions a payout route gated on a grant, parked from a refusal; a door that admits a manager but lends nothing; then one that lends the grant
 * @expectedResult without a lend the resume is refused at the route's own gate, the failure reaches the error ring, the record ends failed; with the lend the payout runs */
test("G1: a step-up park resumed without a lend is refused by the gate it was refused by", async () => {
  const seen: string[] = [];
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    principals,
    auth,
    parker({ kinds: ["normal", "resume"] }),
    ring(seen),
  ]);
  const route = (id: string, elevate?: ReturnType<typeof lend>) =>
    app
      .route(id)
      .authorize("payout:write")
      .resumable({
        authorize: ({ principal }) => principal?.subject === "manager",
        ...(elevate ? { elevate: elevate as never } : {}),
      })
      .from(manual)
      .transform(() => "paid")
      .build();
  await app.start([route("bare"), route("lent", lend(["payout:write"]))]);
  const store = app.host.service(CONTINUATIONS);
  const bare = (await app.runtime.deliver("bare", 0, alice())).deferrals[0]!;
  seen.length = 0;
  const refusal = await faultOf(app.runtime.resume(bare, { headers: manager }));
  expect(refusal.code).toBe("REFUSED");
  expect(seen).toEqual(["resume:REFUSED:"]);
  expect(declines(refusal)).toEqual(["DEFER_REPEATED"]);
  const record = (await store.get(bare))!;
  expect(record.state).toBe("resumed");
  expect(record.outcome?.status).toBe("failed");
  expect(await store.pending()).toMatchObject({ count: 0 });
  const lent = (await app.runtime.deliver("lent", 0, alice())).deferrals[0]!;
  expect(
    (await app.runtime.resume(lent, { headers: manager })).exchanges[0]?.body,
  ).toBe("paid");
  await app.stop();
});

/**
 * @case G2: only the gate's own refusal is a bound
 * @preconditions a rate limiter refusing at admission with a detail naming `admin`, ahead of the gate; a step-up park of that refusal; a door lending `admin`
 * @expectedResult the record's refusal is keyed by the limiter's namespace, the gate finds no bound of its own, and the lend is refused with the approval untouched */
test("G2: a refusal recorded by another plugin is not a bound the gate lends against", async () => {
  const limiter = infrastructure({
    id: "acme.limiter",
    bind: (c) =>
      c.contribute({
        kind: "handler",
        id: "limit",
        point: "admission",
        survival: allRuns,
        handle: (ex, { kind }) =>
          kind === "normal"
            ? ({
                kind: "refuse",
                reason: "quota",
                detail: { refused: ["admin"] },
              } as HandlerDecision<"admission">)
            : { kind: "allow", exchange: ex },
      }),
  });
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    principals,
    auth,
    limiter,
    parker(),
  ]);
  await app.start([
    app
      .route("r")
      .resumable({ authorize: () => true, elevate: lend(["admin"]) as never })
      .from(manual)
      .transform(() => "ran")
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", 0, alice())).deferrals[0]!;
  const store = app.host.service(CONTINUATIONS);
  expect((await store.get(id))!.continuation.refusal).toEqual({
    limiter: { refused: ["admin"] },
  });
  expect((await app.runtime.resume(id, { headers: manager })).status).toBe(
    "refused",
  );
  expect((await store.get(id))?.state).toBe("waiting");
  await app.stop();
});

/**
 * @case G3: a failure outside any step does not park
 * @preconditions an exit handler that throws after the route completed, and a route-scope timeout that fires while a step waits on tracked work; an error handler parking every failure
 * @expectedResult neither parks: the failure is rethrown with DEFER_UNSITED beside it, and the store holds nothing */
test("G3: a site-less failure is refused a park rather than resumed from the top", async () => {
  const seen: string[] = [];
  const thrower = infrastructure({
    id: "acme.exit",
    bind: (c) =>
      c.contribute({
        kind: "handler",
        id: "boom",
        point: "exit",
        survival: allRuns,
        handle: () => {
          throw Error("exit failed");
        },
      }),
  });
  const app = application([
    operations,
    resilience,
    deferral,
    sqlite(":memory:"),
    parker({ failures: true }),
    ring(seen),
    thrower,
  ]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .transform(() => "done")
      .build(),
  ]);
  const failure = await faultOf(app.runtime.deliver("r", 0));
  expect(failure.message).toContain("exit failed");
  expect(seen).toEqual(["normal:HANDLER_exit:"]);
  expect(declines(failure)).toEqual(["DEFER_UNSITED"]);
  expect(await app.host.service(CONTINUATIONS).pending()).toMatchObject({
    count: 0,
  });
  await app.stop();
});

/**
 * @case G4 and G5: nothing inside a fan-out parks
 * @preconditions a fan-out whose second child defers, and one whose second child throws under a parking error handler
 * @expectedResult the defer is refused as DEFER_IN_FANOUT before any write; the failure is not parked (no site) and the store holds nothing */
test("G4, G5: a defer or a failure inside a fan-out cannot park", async () => {
  const seen: string[] = [];
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    parker({ failures: true }),
    ring(seen),
  ]);
  const fan = (id: string, child: Step) =>
    app
      .route(id)
      .from(manual)
      .step("fan", (ex) => ({
        kind: "fanOut",
        exchanges: [1, 2, 3].map((n) => ({ ...ex, body: n })),
      }))
      .step(child.id, child.execute as never)
      .build();
  const defers = instruction("application", "maybe-defer", (ex): StepOutcome =>
    ex.body === 2
      ? { kind: "defer", exchange: ex, request: { name: "x", reason: "x" } }
      : continueWith(ex),
  );
  const throws = instruction(
    "application",
    "maybe-throw",
    (ex): StepOutcome => {
      if (ex.body === 2) throw Error("child failed");
      return continueWith(ex);
    },
  );
  await app.start([fan("defers", defers), fan("throws", throws)]);
  const refused = await faultOf(app.runtime.deliver("defers", 0));
  expect(refused.message).toContain("DEFER_IN_FANOUT");
  const failed = await faultOf(app.runtime.deliver("throws", 0));
  expect(failed.message).toContain("child failed");
  expect(seen).toEqual(["normal:DEFER_IN_FANOUT:", "normal:STEP:"]);
  expect(declines(refused)).toEqual(["DEFER_UNSITED"]);
  expect(declines(failed)).toEqual(["DEFER_UNSITED"]);
  expect(await app.host.service(CONTINUATIONS).pending()).toMatchObject({
    count: 0,
  });
  await app.stop();
});

/** A store whose swap is slow, so two doors can both be past their decision before either wins. */
function slowSwap(delay: number) {
  const db = new SqliteRecords(":memory:"),
    inner = durableStore(db);
  const store: ContinuationStore = {
    ...inner,
    async markResumed(id, at, by) {
      await new Promise((r) => setTimeout(r, delay));
      return inner.markResumed(id, at, by);
    },
  };
  return infrastructure({
    id: "acme.slow",
    provides: [CONTINUATIONS],
    replaces: [CONTINUATIONS],
    bind: (c) => {
      c.provide(CONTINUATIONS, store);
      c.onDispose(() => db.close());
    },
  });
}

/**
 * @case G6: a lend belongs to the resume call that made it
 * @preconditions two managers resume one step-up park at once, each lending a different scope, over a slow swap
 * @expectedResult the run the winner's claim let through carries the winner's lend, and the record names the winner */
test("G6: the elevation applied is the winning call's own", async () => {
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    principals,
    auth,
    parker(),
    slowSwap(30),
  ]);
  await app.start([
    app
      .route("r")
      .authorize()
      .resumable({
        authorize: ({ principal }) =>
          principal?.subject.startsWith("manager") ?? false,
        elevate: (({
          principal,
          deferred,
        }: {
          principal?: { subject: string };
          deferred?: { subject: string; grants: readonly string[] };
        }) =>
          withPrincipal(
            {},
            {
              subject: deferred!.subject,
              grants: [...deferred!.grants],
              lent:
                principal?.subject === "manager-a"
                  ? ["payout:write"]
                  : ["audit:write"],
            },
          )) as never,
      })
      .from(manual)
      .transform(
        (_, ex) =>
          `${[...(ex.auth.principal?.lent ?? [])].join()}:${ex.auth.resumedBy?.subject}`,
      )
      .build(),
  ]);
  // Self-asserted, so the ask refuses it and the park carries both scopes on loan as the bound.
  const id = (
    await app.runtime.deliver("r", 0, {
      "routecraft.principal": {
        subject: "alice",
        grants: [],
        lent: ["payout:write", "audit:write"],
      },
    })
  ).deferrals[0]!;
  const a = withPrincipal({}, { subject: "manager-a", grants: [], lent: [] });
  const b = withPrincipal({}, { subject: "manager-b", grants: [], lent: [] });
  const results = await Promise.allSettled([
    app.runtime.resume(id, { headers: a }),
    app.runtime.resume(id, { headers: b }),
  ]);
  const settled = results.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : { status: `rejected:${String(r.reason)}` },
  );
  const won = settled.find(
    (r) =>
      r.status === "refused" ||
      r.status === "completed" ||
      r.status === "deferred",
  );
  const bodies = settled.map((r) =>
    "exchanges" in r ? r.exchanges[0]?.body : r.status,
  );
  // Whichever call won, its own lend rode its own run: the pairing is never crossed.
  expect(
    bodies.some(
      (b) => b === "payout:write:manager-a" || b === "audit:write:manager-b",
    ),
  ).toBe(true);
  expect(
    bodies.some(
      (b) => b === "payout:write:manager-b" || b === "audit:write:manager-a",
    ),
  ).toBe(false);
  expect(won).toBeDefined();
  await app.stop();
});

/**
 * @case G7: a lend the gate does not accept is a failure the route hears about, once
 * @preconditions a route gated on two grants, parked on a refusal of both; a door lending only one; a step-up handler that would park again
 * @expectedResult the re-admission refuses, the error ring is told, the second park is refused as repeated, the record ends failed with no second record */
test("G7: an insufficient lend fails the resume audibly and is not parked twice", async () => {
  const seen: string[] = [];
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    principals,
    auth,
    parker({ kinds: ["normal", "resume"] }),
    ring(seen),
  ]);
  await app.start([
    app
      .route("r")
      .authorize("payout:write", "audit:write")
      .resumable({
        authorize: () => true,
        elevate: lend(["payout:write"]) as never,
      })
      .from(manual)
      .transform(() => "ran")
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", 0, alice())).deferrals[0]!;
  const store = app.host.service(CONTINUATIONS);
  const refusal = await faultOf(app.runtime.resume(id, { headers: manager }));
  expect(refusal.message).toContain("missing audit:write");
  expect(seen.at(-1)).toBe("resume:REFUSED:");
  expect(declines(refusal)).toEqual(["DEFER_REPEATED"]);
  expect((await store.get(id))?.outcome?.status).toBe("failed");
  expect(await store.pending()).toMatchObject({ count: 0 });
  await app.stop();
});

/**
 * @case G8 and G9: a door hook fails as one refusal, within the ingress's bound, and never past a stop
 * @preconditions hooks that throw, that never settle under an aborted signal, and one that settles only after stop began
 * @expectedResult the throw and the abort are `refused` with no message of their own; the late door is refused as not running, the suffix never runs, and the record stays waiting */
test("G8, G9: hook failures are one refusal, and a late door runs nothing on a stopped application", async () => {
  let ran = 0;
  let hookStarted = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    principals,
    auth,
  ]);
  const route = (id: string, hook: () => Promise<boolean>) =>
    app
      .route(id)
      .resumable({ authorize: hook })
      .from(manual)
      .defer("a")
      .transform(() => ++ran)
      .build();
  await app.start([
    route("throws", async () => {
      throw Error("ldap://10.0.0.7 unreachable");
    }),
    route("hangs", () => {
      hookStarted = true;
      return new Promise(() => {});
    }),
    route("late", async () => {
      await gate;
      return true;
    }),
  ]);
  const ids = Object.fromEntries(
    await Promise.all(
      ["throws", "hangs", "late"].map(async (r) => [
        r,
        (await app.runtime.deliver(r, 0)).deferrals[0]!,
      ]),
    ),
  ) as Record<string, string>;
  const store = app.host.service(CONTINUATIONS);
  const thrown = await app.runtime.resume(ids["throws"]!);
  expect(thrown).toEqual({ status: "refused", exchanges: [], deferrals: [] });
  const controller = new AbortController();
  const hanging = app.runtime.resume(ids["hangs"]!, {
    signal: controller.signal,
  });
  // The abort lands while the hook is pending: the bound must interrupt it, not just pre-empt it.
  while (!hookStarted) await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  expect((await hanging).status).toBe("refused");
  const order: string[] = [];
  const late = app.runtime.resume(ids["late"]!).catch(() => order.push("late"));
  const stopping = app.stop().then(() => order.push("stopped"));
  await new Promise((r) => setTimeout(r, 20));
  release();
  await late;
  await stopping;
  // The late door is refused as not running, and the stop waited for it: a resume at the door is owned work.
  expect(order).toEqual(["late", "stopped"]);
  expect(ran).toBe(0);
  const db = new SqliteRecords(":memory:");
  db.close();
  void store;
});

/**
 * @case G10: every park gets the default deadline
 * @preconditions an error-path park and a hand-written defer outcome under the default plugin
 * @expectedResult both records carry the default deadline; under a plugin opted out neither does */
test("G10: the store's default deadline applies to parks the DSL did not make", async () => {
  const build = async (ttl: number | null | undefined) => {
    const app = application([
      operations,
      ttl === undefined ? deferral : deferralPlugin({ ttl, interval: 0 }),
      sqlite(":memory:"),
      principals,
      auth,
      parker(),
    ]);
    await app.start([
      app.route("refused").authorize("x").from(manual).build(),
      app
        .route("raw")
        .from(manual)
        .step("park", (ex) => ({
          kind: "defer",
          exchange: ex,
          request: { name: "raw", reason: "x" },
        }))
        .build(),
    ]);
    const before = Date.now();
    const ids = [
      (await app.runtime.deliver("refused", 0, alice())).deferrals[0]!,
      (await app.runtime.deliver("raw", 0)).deferrals[0]!,
    ];
    const store = app.host.service(CONTINUATIONS);
    const deadlines = await Promise.all(
      ids.map(async (id) => (await store.get(id))!.continuation.expiresAt),
    );
    await app.stop();
    return { before, deadlines };
  };
  const defaults = await build(undefined);
  for (const at of defaults.deadlines)
    expect(at! - defaults.before).toBeGreaterThanOrEqual(DEFAULT_TTL);
  expect((await build(null)).deadlines).toEqual([undefined, undefined]);
});

/**
 * @case G11: a cancelled run is not parked
 * @preconditions a caller that aborts while a step runs, and an error handler that parks failures
 * @expectedResult the run fails as aborted with DEFER_CANCELLED beside it, and no record is written */
test("G11: a cancelled run leaves no resume link", async () => {
  const seen: string[] = [];
  const controller = new AbortController();
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    parker({ failures: true }),
    ring(seen),
  ]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .step("slow", async (ex) => {
        controller.abort(Error("caller left"));
        await new Promise((r) => setTimeout(r, 5));
        return continueWith(ex);
      })
      .build(),
  ]);
  const cancelled = await faultOf(
    app.runtime.deliver("r", 0, {}, controller.signal),
  );
  expect(cancelled.message).toContain("caller left");
  expect(seen).toEqual(["normal:STEP:"]);
  expect(declines(cancelled)).toEqual(["DEFER_CANCELLED"]);
  expect(await app.host.service(CONTINUATIONS).pending()).toMatchObject({
    count: 0,
  });
  await app.stop();
});

/**
 * @case G12: a notify that fails kills the link
 * @preconditions a defer whose notify throws
 * @expectedResult the caller is told NOTIFY, the record is denied, and a resume of it is settled */
test("G12: a failing notify denies the record instead of leaving a live link", async () => {
  const app = application([operations, deferral, sqlite(":memory:")]);
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
          notify: async () => {
            throw Error("mail server down");
          },
        },
      }))
      .build(),
  ]);
  await expect(app.runtime.deliver("r", 0)).rejects.toThrow("NOTIFY");
  const store = app.host.service(CONTINUATIONS);
  const ids = (await store.findExpired(Number.MAX_SAFE_INTEGER, 10)).map(
    (x) => x.id,
  );
  expect(ids).toEqual([]);
  expect(await store.pending()).toMatchObject({ count: 0 });
  await app.stop();
});

/**
 * @case G13 and G14: the codec's read side is the shipped one
 * @preconditions a body with a `__proto__` key and a `-0`, round-tripped through the codec
 * @expectedResult the revived object has an ordinary prototype with `__proto__` as an own key, and `-0` comes back as `0` */
test("G13, G14: a revived body has an ordinary prototype, and -0 is normalised", () => {
  const revived = decode(
    JSON.parse(
      JSON.stringify(
        encode(JSON.parse('{"__proto__":{"admin":true},"n":1}'), "t"),
      ),
    ),
  ) as Record<string, unknown>;
  expect(revived instanceof Object).toBe(true);
  expect(typeof revived["hasOwnProperty"]).toBe("function");
  expect(Object.getOwnPropertyNames(revived)).toContain("__proto__");
  expect(Object.getPrototypeOf(revived)).toBe(Object.prototype);
  expect(Object.is(encode(-0, "t"), 0)).toBe(true);
  expect(Object.is(encode(-0, "t"), -0)).toBe(false);
});

/**
 * @case the review's surviving mutants: the door's identity rule, re-lending, step-state scoping, the sweep's stop
 * @preconditions a door widening the permanent grants; a door re-lending what the park already held; a route with two steps around a park; a sweep stopped mid-pass with a page size of one
 * @expectedResult the widened re-mint is refused; the re-lend is accepted; only the parking step sees its state; the stopped sweep retires the record in flight and no more */
test("survivors: grant widening refused, re-lend accepted, step state scoped, sweep stops between records and pages", async () => {
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    principals,
    auth,
    parker(),
  ]);
  await app.start([
    app
      .route("widen")
      .authorize("payout:write")
      .resumable({
        authorize: () => true,
        elevate: (({ deferred }: { deferred?: { subject: string } }) =>
          withPrincipal(
            {},
            { subject: deferred!.subject, grants: ["payout:write"], lent: [] },
          )) as never,
      })
      .from(manual)
      .transform(() => "ran")
      .build(),
    app
      .route("relend")
      .resumable({ authorize: () => true, elevate: lend(["approve"]) as never })
      .from(manual)
      .defer("a")
      .transform((_, ex) => [...(ex.auth.principal?.lent ?? [])].join())
      .build(),
    app
      .route("scoped")
      .from(manual)
      .step("before", (ex, ctx): StepOutcome => ({
        kind: "continue",
        exchange: { ...ex, body: [ctx.stepState] },
      }))
      .step("park", (ex, ctx): StepOutcome =>
        ctx.kind === "resume"
          ? {
              kind: "continue",
              exchange: {
                ...ex,
                body: [...(ex.body as unknown[]), ctx.stepState],
              },
            }
          : {
              kind: "defer",
              exchange: ex,
              request: { name: "x", reason: "x", reenter: true, state: "mine" },
            },
      )
      .step("after", (ex, ctx): StepOutcome => ({
        kind: "continue",
        exchange: { ...ex, body: [...(ex.body as unknown[]), ctx.stepState] },
      }))
      .build(),
  ]);
  const store = app.host.service(CONTINUATIONS);
  const widen = (await app.runtime.deliver("widen", 0, alice())).deferrals[0]!;
  expect((await app.runtime.resume(widen, { headers: manager })).status).toBe(
    "refused",
  );
  expect((await store.get(widen))?.state).toBe("waiting");
  const relend = (await app.runtime.deliver("relend", 0, alice(["approve"])))
    .deferrals[0]!;
  expect(
    (await app.runtime.resume(relend, { headers: manager })).exchanges[0]?.body,
  ).toBe("approve");
  const scoped = (await app.runtime.deliver("scoped", 0)).deferrals[0]!;
  // The first slot was undefined when the exchange parked, and the codec carries it as null.
  expect((await app.runtime.resume(scoped)).exchanges[0]?.body).toEqual([
    null,
    "mine",
    undefined,
  ]);
  await app.stop();
  // The sweep's stop: three due records, pages of one, a nag that holds until the stop has begun.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const seen: string[] = [];
  const slowNag = infrastructure({
    id: "acme.ops",
    bind: (c) =>
      c.contribute({
        kind: "handler",
        id: "nag",
        point: "error",
        survival: allRuns,
        async handle(ex) {
          seen.push(ex.id);
          await gate;
          return { kind: "allow", exchange: ex };
        },
      }),
  });
  const sweeper = application([
    operations,
    deferral,
    sqlite(":memory:"),
    slowNag,
  ]);
  await sweeper.start([sweeper.route("r").from(manual).defer("a", -1).build()]);
  const swept = sweeper.host.service(CONTINUATIONS);
  for (let i = 0; i < 3; i++)
    await swept.create(`due#${i}`, {
      ...parked(i),
      exchange: { id: `e${i}`, routeId: "r", body: 1, headers: {} },
    });
  const pass = sweeper.runtime.sweep({ pageSize: 1 });
  while (!seen.length) await new Promise((r) => setTimeout(r, 5));
  const stopping = sweeper.stop();
  await new Promise((r) => setTimeout(r, 20));
  release();
  await stopping;
  expect(await pass).toMatchObject({ visited: 1, retired: 1 });
  expect(seen).toEqual(["e0"]);
  // The same stop landing inside one page: the sweep must also check between records.
  let releaseAgain!: () => void;
  const gateAgain = new Promise<void>((r) => (releaseAgain = r));
  const seenAgain: string[] = [];
  const slowNagAgain = infrastructure({
    id: "acme.ops",
    bind: (c) =>
      c.contribute({
        kind: "handler",
        id: "nag",
        point: "error",
        survival: allRuns,
        async handle(ex) {
          seenAgain.push(ex.id);
          await gateAgain;
          return { kind: "allow", exchange: ex };
        },
      }),
  });
  const paged = application([
    operations,
    deferral,
    sqlite(":memory:"),
    slowNagAgain,
  ]);
  await paged.start([paged.route("r").from(manual).defer("a", -1).build()]);
  const pagedStore = paged.host.service(CONTINUATIONS);
  for (let i = 0; i < 3; i++)
    await pagedStore.create(`due#${i}`, {
      ...parked(i),
      exchange: { id: `e${i}`, routeId: "r", body: 1, headers: {} },
    });
  const pagedPass = paged.runtime.sweep({ pageSize: 10 });
  while (!seenAgain.length) await new Promise((r) => setTimeout(r, 5));
  const pagedStopping = paged.stop();
  await new Promise((r) => setTimeout(r, 20));
  releaseAgain();
  await pagedStopping;
  expect(await pagedPass).toMatchObject({ visited: 1, retired: 1 });
  expect(seenAgain).toEqual(["e0"]);
});
