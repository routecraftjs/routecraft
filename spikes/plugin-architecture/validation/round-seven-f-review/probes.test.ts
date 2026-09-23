import { test, expect } from "bun:test";
import {
  application,
  infrastructure,
  operations,
  resilience,
  deferral,
  sqlite,
  auth,
  principals,
  manual,
  withPrincipal,
  allRuns,
  CONTINUATIONS,
  SqliteRecords,
  durableStore,
  Fault,
  type ContinuationStore,
  type DeferRequest,
} from "../../src/v2/index.ts";

/**
 * Round 7f clean-room review probes. Every test is a CHARACTERISATION: it
 * asserts what head `814748e4` does, so this file is green on that head and
 * every assertion is a reproduced fact. Where the fact is a regression
 * against `#818` or the shipped framework, the JSDoc names the reference.
 * The README maps each probe to its finding.
 */

const bob = withPrincipal(
  {},
  { subject: "bob", grants: ["payout:write"], lent: [] },
);
const manager = withPrincipal(
  {},
  { subject: "manager", grants: ["lend"], lent: [] },
);
const alice = () =>
  withPrincipal({}, { subject: "alice", grants: [], lent: [] });

/** Parks every failure of a normal run from the error ring, with an optional request override. */
const parker = (
  extra: Partial<DeferRequest> = {},
  when: (code: string | undefined) => boolean = () => true,
  seen: string[] = [],
) =>
  infrastructure({
    id: "acme.parker",
    bind: (c) =>
      c.contribute({
        kind: "handler",
        id: "park",
        point: "error",
        survival: allRuns,
        mayDefer: true,
        handle: (ex, { error, kind }) => {
          seen.push(`${kind}:${error?.code}`);
          return kind === "normal" && when(error?.code)
            ? {
                kind: "defer",
                request: { name: "later", reason: "failed", ...extra },
              }
            : { kind: "allow", exchange: ex };
        },
      }),
  });

const principalBody = (
  _: unknown,
  ex: {
    auth: {
      principal?: {
        subject: string;
        authentic: boolean;
        grants: readonly string[];
        lent: readonly string[];
      };
    };
  },
) =>
  `${ex.auth.principal?.subject}:${ex.auth.principal?.authentic}:${[...(ex.auth.principal?.grants ?? []), ...(ex.auth.principal?.lent ?? [])].join()}`;

/**
 * @case G1: a step-up park resumed without `elevate` runs the route as the refused requester
 * @preconditions a route gated on `payout:write`; alice lacks it and is parked by the error ring; the door's `authorize` admits a manager who does not hold `payout:write`; no `elevate`
 * @expectedResult (head) the payout runs, as alice restored, holding nothing; nobody holding `payout:write` was ever asked. `#818` re-runs `.authorize()` on the continuation (`revive.ts` rehydrate JSDoc) and refuses the restored principal */
test("G1: a refusal park resumed without elevate bypasses the route's own gate", async () => {
  const ran: string[] = [];
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    principals,
    auth,
    parker({}, (code) => code === "REFUSED"),
  ]);
  await app.start([
    app
      .route("payout")
      .authorize("payout:write")
      .resumable({
        authorize: ({ principal }) => principal?.subject === "manager",
      })
      .from(manual)
      .transform((b, ex) => {
        const who = principalBody(b, ex);
        ran.push(who);
        return who;
      })
      .build(),
    app
      .route("default-door")
      .authorize("payout:write")
      .from(manual)
      .transform((b, ex) => {
        const who = principalBody(b, ex);
        ran.push(who);
        return who;
      })
      .build(),
  ]);
  const hooked = await app.runtime.deliver("payout", 0, alice());
  expect(hooked.status).toBe("deferred");
  const resumed = await app.runtime.resume(hooked.deferrals[0]!, {
    headers: manager,
  });
  expect(resumed.status).toBe("completed");
  expect(resumed.exchanges[0]?.body).toBe("alice:false:");
  // The default door (ruling 13) asks the resumer for the route's grants, then runs the route as alice anyway.
  const plain = await app.runtime.deliver("default-door", 0, alice());
  expect(
    (await app.runtime.resume(plain.deferrals[0]!, { headers: bob }))
      .exchanges[0]?.body,
  ).toBe("alice:false:");
  expect(ran).toEqual(["alice:false:", "alice:false:"]);
  await app.stop();
});

/**
 * @case G2: the lend bound is whatever the failure's `detail` says, and any plugin authors it
 * @preconditions a third-party admission handler refuses with `detail: { refused: ["admin"] }`; a step throws a Fault whose detail names `root`; the error ring parks both; `elevate` lends what the bound names
 * @expectedResult (head) both parks record the author's list as the bound and the door lends `admin` / `root`. `#818` reads the bound only from the framework's own insufficient-authority error (`insufficientAuthorityOf(originalError)?.scopes`, executor.ts) */
test("G2: any refusing plugin or throwing step writes the lend bound", async () => {
  const limiter = infrastructure({
    id: "acme.limiter",
    bind: (c) =>
      c.contribute({
        kind: "handler",
        id: "limit",
        point: "admission",
        survival: allRuns,
        handle: (ex, { kind }) =>
          kind === "normal" && ex.body === "limited"
            ? {
                kind: "refuse",
                reason: "slow down",
                detail: { refused: ["admin"] },
              }
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
  const elevate =
    (grant: string) =>
    ({
      deferred,
    }: {
      deferred?: { subject: string; grants: readonly string[] };
    }) =>
      withPrincipal(
        {},
        {
          subject: deferred!.subject,
          grants: [...deferred!.grants],
          lent: [grant],
        },
      );
  await app.start([
    app
      .route("limited")
      .resumable({ authorize: () => true, elevate: elevate("admin") as never })
      .from(manual)
      .transform((b, ex) => principalBody(b, ex))
      .build(),
    app
      .route("thrower")
      .resumable({ authorize: () => true, elevate: elevate("root") as never })
      .from(manual)
      .step("boom", (ex, ctx) => {
        if (ctx.kind === "resume")
          return {
            kind: "continue",
            exchange: { ...ex, body: principalBody(ex.body, ex as never) },
          };
        const f = new Fault("acme.app", "BOOM", "downstream 500");
        f.detail = { refused: ["root"] };
        throw f;
      })
      .build(),
  ]);
  const store = app.host.service(CONTINUATIONS);
  const a = await app.runtime.deliver("limited", "limited", alice());
  expect((await store.get(a.deferrals[0]!))?.continuation.refusal).toEqual({
    refused: ["admin"],
  });
  expect(
    (await app.runtime.resume(a.deferrals[0]!, { headers: manager }))
      .exchanges[0]?.body,
  ).toBe("alice:true:admin");
  const b = await app.runtime.deliver("thrower", 0, alice());
  expect((await store.get(b.deferrals[0]!))?.continuation.refusal).toEqual({
    refused: ["root"],
  });
  expect(
    (await app.runtime.resume(b.deferrals[0]!, { headers: manager }))
      .exchanges[0]?.body,
  ).toBe("alice:true:root");
  await app.stop();
});

/**
 * @case G3: a failure with no step site parks the whole route, and the resume re-runs completed steps
 * @preconditions a route-scope `.timeout(40)` that fires while the route waits on a tracked stream, after its first step committed an effect; an exit handler that throws after a route completed; the error ring parks both
 * @expectedResult (head) both park with `site: null` from the route's first step, and each resume runs the committed effect a second time. `#818` refuses exactly this park with RC5051 ("parking there would have to resume from the top of the route and re-run every step that already completed", executor.ts parkFromErrorPath) */
test("G3: a wrapper or exit failure parks from the top and re-runs committed effects", async () => {
  const effects: string[] = [];
  let slow = true;
  let exitThrows = true;
  const exitBomb = infrastructure({
    id: "acme.exit",
    bind: (c) =>
      c.contribute({
        kind: "handler",
        id: "bomb",
        point: "exit",
        survival: allRuns,
        selector: { routeId: "exit" },
        handle: (ex) => {
          if (exitThrows) {
            exitThrows = false;
            throw Error("exit handler failed");
          }
          return { kind: "allow", exchange: ex };
        },
      }),
  });
  const app = application([
    operations,
    resilience,
    deferral,
    sqlite(":memory:"),
    exitBomb,
    parker(),
  ]);
  await app.start([
    app
      .route("timed")
      .timeout(40)
      .from(manual)
      .transform((b) => {
        effects.push("charge:timed");
        return b;
      })
      .step("stream", (ex, ctx) => {
        // A response streamed after the step returned: in-flight work the route waits for.
        if (slow) ctx.track(new Promise((r) => setTimeout(r, 120)));
        return { kind: "continue", exchange: ex };
      })
      .build(),
    app
      .route("exit")
      .from(manual)
      .transform((b) => {
        effects.push("charge:exit");
        return b;
      })
      .build(),
  ]);
  const store = app.host.service(CONTINUATIONS);
  const timed = await app.runtime.deliver("timed", 1);
  expect(timed.status).toBe("deferred");
  expect((await store.get(timed.deferrals[0]!))?.continuation).toMatchObject({
    site: null,
    frames: [{ list: null, from: 0 }],
  });
  slow = false;
  await app.runtime.resume(timed.deferrals[0]!);
  const exit = await app.runtime.deliver("exit", 1);
  expect(exit.status).toBe("deferred");
  await app.runtime.resume(exit.deferrals[0]!);
  expect(effects).toEqual([
    "charge:timed",
    "charge:timed",
    "charge:exit",
    "charge:exit",
  ]);
  await app.stop();
});

/**
 * @case G4: a failure inside a fan-out parks one child and silently loses the others
 * @preconditions a step fans out three children; the next step fails for the second only; the error ring parks
 * @expectedResult (head) the route reports `deferred` with no exchanges: the first child's completion is gone from the result, the third child never runs and is not parked, and exactly one record exists */
test("G4: an error-path park inside a fan-out drops the siblings", async () => {
  const done: unknown[] = [];
  const app = application([operations, deferral, sqlite(":memory:"), parker()]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .step("split", (ex) => ({
        kind: "fanOut",
        exchanges: [1, 2, 3].map((n) => ({
          ...ex,
          id: `${ex.id}.${n}`,
          body: n,
        })),
      }))
      .transform((b) => {
        if (b === 2) throw Error("child 2 failed");
        done.push(b);
        return b;
      })
      .build(),
  ]);
  const result = await app.runtime.deliver("r", 0);
  expect(result.status).toBe("deferred");
  expect(result.exchanges).toEqual([]);
  expect(done).toEqual([1]);
  expect(await app.host.service(CONTINUATIONS).pending()).toMatchObject({
    count: 1,
  });
  await app.stop();
});

/**
 * @case G5: a defer inside a fan-out is not refused, and children sharing the parent id collide
 * @preconditions a fan-out whose children keep the parent's exchange id (the shape `{ ...ex, body }` a split naturally writes), each then reaching `.defer()`
 * @expectedResult (head) the first child parks, the second fails with DUPLICATE_DEFERRAL after the first record is durable, and the caller is told the route failed while a live record waits. Shipped refuses a park inside a split before anything is written (the 7e review's F7 cites it; 7f refused it only under `runPath`) */
test("G5: a defer inside a fan-out parks the first child and fails the route", async () => {
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .step("split", (ex) => ({
        kind: "fanOut",
        exchanges: [1, 2].map((n) => ({ ...ex, body: n })),
      }))
      .defer("a")
      .build(),
  ]);
  await expect(app.runtime.deliver("r", 0)).rejects.toThrow(
    "DUPLICATE_DEFERRAL",
  );
  expect(await app.host.service(CONTINUATIONS).pending()).toMatchObject({
    count: 1,
  });
  await app.stop();
});

/** A continuation store whose swap is slow, so two resumes interleave at the door. */
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
 * @case G6: the held elevation is keyed by record id, so a losing resumer's lend is applied to the winner's run
 * @preconditions two managers resume one step-up park concurrently; `junior` wins the swap and lends nothing, `senior` loses it and lends `payout:write`
 * @expectedResult (head) the run the junior's claim let through carries the senior's lend, and the record says the junior resumed it. `#818` holds the elevation in the resume call's own frame (`const elevated = ...` in reviveDeferral) and applies it in the same call */
test("G6: a concurrent loser's elevation is applied to the winner's continuation", async () => {
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    slowSwap(60),
    principals,
    auth,
    parker({}, (code) => code === "REFUSED"),
  ]);
  const person = (subject: string) =>
    withPrincipal({}, { subject, grants: ["lend"], lent: [] });
  await app.start([
    app
      .route("payout")
      .authorize("payout:write")
      .resumable({
        authorize: ({ principal }) =>
          principal?.subject === "junior" || principal?.subject === "senior",
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
              lent: principal?.subject === "senior" ? ["payout:write"] : [],
            },
          )) as never,
      })
      .from(manual)
      .transform(
        (b, ex) => `${principalBody(b, ex)}:by=${ex.auth.resumedBy?.subject}`,
      )
      .build(),
  ]);
  const id = (await app.runtime.deliver("payout", 0, alice())).deferrals[0]!;
  const junior = app.runtime.resume(id, { headers: person("junior") });
  await new Promise((r) => setTimeout(r, 10));
  const senior = app.runtime.resume(id, { headers: person("senior") });
  const [j, s] = await Promise.all([junior, senior]);
  expect(j.exchanges[0]?.body).toBe("alice:true:payout:write:by=junior");
  expect(s.status).toBe("duplicate");
  await app.stop();
});

/**
 * @case G7: a lend inside the bound that does not satisfy the gate spends the approval and tells nobody
 * @preconditions a step-up park; `elevate` returns a valid re-mint that lends nothing
 * @expectedResult (head) the door accepts, the swap is spent, entry refuses, `resume` returns `refused`, the record is `resumed` with a cached `refused` outcome, and the error ring is never told. `#818` re-runs `.authorize()` on the continuation, so the refusal is a failure its error handler sees, with the loop-closing rule refusing a second park */
test("G7: an insufficient lend is a silent spent approval", async () => {
  const seen: string[] = [];
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    principals,
    auth,
    parker({}, (code) => code === "REFUSED", seen),
  ]);
  await app.start([
    app
      .route("payout")
      .authorize("payout:write")
      .resumable({
        authorize: () => true,
        elevate: (({
          deferred,
        }: {
          deferred?: { subject: string; grants: readonly string[] };
        }) =>
          withPrincipal(
            {},
            {
              subject: deferred!.subject,
              grants: [...deferred!.grants],
              lent: [],
            },
          )) as never,
      })
      .from(manual)
      .transform(() => "paid")
      .build(),
  ]);
  const id = (await app.runtime.deliver("payout", 0, alice())).deferrals[0]!;
  seen.length = 0;
  expect((await app.runtime.resume(id, { headers: manager })).status).toBe(
    "refused",
  );
  const record = await app.host.service(CONTINUATIONS).get(id);
  expect(record?.state).toBe("resumed");
  expect(record?.outcome?.status).toBe("refused");
  expect(seen).toEqual([]);
  await app.stop();
});

/**
 * @case G8: a door hook's failure is distinguishable from its refusal, and carries the hook's own message
 * @preconditions one route whose `authorize` returns false, one whose `authorize` throws with an internal detail
 * @expectedResult (head) false is `{ status: "refused" }`; a throw rejects `resume` with a fault whose message carries the hook's text. `#818` answers false, a throw and an unsettled hook with one RC5056 and one message ("a hook whose failures are distinguishable from outside is an oracle", authorize.ts runAuthorizer) */
test("G8: a throwing door hook is an oracle", async () => {
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    principals,
    auth,
  ]);
  await app.start([
    app
      .route("no")
      .resumable({ authorize: () => false })
      .from(manual)
      .defer("a")
      .build(),
    app
      .route("broken")
      .resumable({
        authorize: () => {
          throw Error("ldap://10.0.0.7 unreachable");
        },
      })
      .from(manual)
      .defer("a")
      .build(),
  ]);
  const no = (await app.runtime.deliver("no", 0)).deferrals[0]!;
  const broken = (await app.runtime.deliver("broken", 0)).deferrals[0]!;
  expect((await app.runtime.resume(no, { headers: bob })).status).toBe(
    "refused",
  );
  await expect(app.runtime.resume(broken, { headers: bob })).rejects.toThrow(
    "ldap://10.0.0.7 unreachable",
  );
  await app.stop();
});

/**
 * @case G9: a door hook is not bounded by anything, and one that settles after `stop()` is not owned work
 * @preconditions an `authorize` hook that waits on a latch; `stop()` runs while it waits; the latch opens after
 * @expectedResult (head) `stop()` resolves with the resume still pending at the door, and the resume then fails against the disposed store rather than being refused as a stopped runtime. `#818` races both hooks against the ingress route's abort signal (`settleOrAbort(..., door.signal)`) */
test("G9: an unsettled door hook outlives stop", async () => {
  let open!: () => void;
  const latch = new Promise<void>((r) => (open = r));
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    principals,
    auth,
  ]);
  await app.start([
    app
      .route("r")
      .resumable({
        authorize: async () => {
          await latch;
          return true;
        },
      })
      .from(manual)
      .defer("a")
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", 0)).deferrals[0]!;
  let settled = "pending";
  const resuming = app.runtime.resume(id, { headers: bob }).then(
    (r) => (settled = `resolved:${r.status}`),
    (e: Error) => (settled = `rejected:${e.message}`),
  );
  await app.stop();
  expect(settled).toBe("pending");
  open();
  await resuming;
  expect(settled).not.toContain("NOT_RUNNING");
  expect(settled.startsWith("rejected:")).toBe(true);
  expect(settled).toContain("MARK_RESUMED");
});

/**
 * @case G10: parks that do not come through `.defer()` or the facet get no deadline
 * @preconditions the default deferral plugin (72 h ttl); an error-ring park; a hand-written step returning a defer outcome with no ttl
 * @expectedResult (head) neither record has `expiresAt`, so neither is ever swept. Shipped and `#818` apply the context default in `deferExchange` to every park (`request.expiresInMs ?? runtime.defaultTtlMs`, defer.ts) */
test("G10: the default ttl misses error-path parks and hand-written defers", async () => {
  const app = application([operations, deferral, sqlite(":memory:"), parker()]);
  await app.start([
    app
      .route("fails")
      .from(manual)
      .transform(() => {
        throw Error("x");
      })
      .build(),
    app
      .route("raw")
      .from(manual)
      .step("park", (ex) => ({
        kind: "defer",
        exchange: ex,
        request: { name: "raw", reason: "raw" },
      }))
      .build(),
  ]);
  const store = app.host.service(CONTINUATIONS);
  const a = (await app.runtime.deliver("fails", 0)).deferrals[0]!;
  const b = (await app.runtime.deliver("raw", 0)).deferrals[0]!;
  expect((await store.get(a))?.continuation.expiresAt).toBeUndefined();
  expect((await store.get(b))?.continuation.expiresAt).toBeUndefined();
  await app.stop();
});

/**
 * @case G11: a run cancelled mid-step can still be parked from the error ring
 * @preconditions a step waiting on the run's signal; the caller aborts; the error ring parks every failure
 * @expectedResult (head) the cancelled run reports `deferred` and leaves a live, resumable record. `#818` refuses the park with RC5054 before the write, and denies a record whose write raced the abort */
test("G11: a cancelled run leaves a live resume link", async () => {
  const app = application([operations, deferral, sqlite(":memory:"), parker()]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .step(
        "wait",
        (ex, ctx) =>
          new Promise((_, reject) =>
            ctx.signal.addEventListener("abort", () =>
              reject(ctx.signal.reason),
            ),
          ),
      )
      .build(),
  ]);
  const controller = new AbortController();
  const running = app.runtime.deliver("r", 0, {}, controller.signal);
  await new Promise((r) => setTimeout(r, 10));
  controller.abort(Error("caller went away"));
  const result = await running;
  expect(result.status).toBe("deferred");
  expect(
    (await app.host.service(CONTINUATIONS).get(result.deferrals[0]!))?.state,
  ).toBe("waiting");
  await app.stop();
});

/**
 * @case G12: a notify hook that fails leaves the record live while the caller is told the run failed
 * @preconditions `.defer`-shaped step whose request carries a notify that throws
 * @expectedResult (head) `deliver` rejects with NOTIFY and the record is `waiting` and resumable. `#818` denies the record claim-first when notify throws or never settles, so the link is dead (defer.ts runNotify, RC5067) */
test("G12: a failed notify leaves a live link behind a failed run", async () => {
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .step("park", (ex) => ({
        kind: "defer",
        exchange: ex,
        request: {
          name: "n",
          reason: "n",
          ttl: 60_000,
          notify: () => {
            throw Error("mail relay down");
          },
        },
      }))
      .build(),
  ]);
  await expect(app.runtime.deliver("r", 0)).rejects.toThrow("NOTIFY");
  const store = app.host.service(CONTINUATIONS);
  expect(await store.pending()).toMatchObject({ count: 1 });
  await app.stop();
});

/**
 * @case G13: a revived body has a null prototype
 * @preconditions a body `{ amount: 5 }` parks and resumes; the continuation calls `hasOwnProperty` and interpolates the body
 * @expectedResult (head) `hasOwnProperty` is not a function and `instanceof Object` is false. Shipped `decode` deliberately revives an ordinary prototype through `defineProperty` ("a null-prototype body would break `instanceof Object` and `hasOwnProperty` call sites", serialize.ts), while the spike's docs call its codec the shipped rules */
test("G13: a resumed body is a null-prototype object", async () => {
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("a")
      .transform((b: unknown) => ({
        instanceOfObject: b instanceof Object,
        hasOwn: typeof (b as { hasOwnProperty?: unknown }).hasOwnProperty,
      }))
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", { amount: 5 })).deferrals[0]!;
  const done = await app.runtime.resume(id);
  expect(done.exchanges[0]?.body).toEqual({
    instanceOfObject: false,
    hasOwn: "undefined",
  });
  await app.stop();
});

/**
 * @case G14: `-0` is not normalised
 * @preconditions `encode(-0)`
 * @expectedResult (head) `-0` is returned; shipped returns `0` so the persisted form does not depend on the backend */
test("G14: the codec keeps -0", async () => {
  const { encode } = await import("../../src/v2/index.ts");
  expect(Object.is(encode(-0, "t"), -0)).toBe(true);
});

/**
 * @case G9b: with a store that outlives the application (a vendor's remote store), a door that settles after `stop()` spends the approval and runs the continuation on a stopped application
 * @preconditions a vendor continuation store that is not closed at dispose; an `authorize` hook waiting on a latch; `stop()` completes; the latch opens
 * @expectedResult (head) the resume completes, the suffix runs after `stop()` resolved, and the record is `resumed`. `resume` checks `#accept` once, before the door, and the door is not owned work */
test("G9b: a late door runs the continuation after stop", async () => {
  const db = new SqliteRecords(":memory:"),
    store = durableStore(db);
  const vendor = infrastructure({
    id: "acme.remote",
    provides: [CONTINUATIONS],
    replaces: [CONTINUATIONS],
    bind: (c) => c.provide(CONTINUATIONS, store),
  });
  let open!: () => void;
  const latch = new Promise<void>((r) => (open = r));
  const ran: string[] = [];
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    vendor,
    principals,
    auth,
  ]);
  await app.start([
    app
      .route("r")
      .resumable({
        authorize: async () => {
          await latch;
          return true;
        },
      })
      .from(manual)
      .defer("a")
      .transform((b) => {
        ran.push("suffix");
        return b;
      })
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", 0)).deferrals[0]!;
  const resuming = app.runtime.resume(id, { headers: bob });
  await app.stop();
  expect(ran).toEqual([]);
  open();
  expect((await resuming).status).toBe("completed");
  expect(ran).toEqual(["suffix"]);
  expect((await store.get(id))?.state).toBe("resumed");
  db.close();
});
