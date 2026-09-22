import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  application,
  infrastructure,
  instruction,
  operations,
  deferral,
  deferralPlugin,
  sqlite,
  auth,
  principals,
  manual,
  withPrincipal,
  mint,
  point,
  fingerprint,
  allRuns,
  AUTHORITY,
  ENFORCEMENT,
  CONTINUATIONS,
  PRINCIPAL_HEADER,
  DEFERRAL_RESUMED_BY,
  SqliteRecords,
  durableStore,
  type Authority,
  type Continuation,
  type Exchange,
  type Handler,
  type StepOutcome,
} from "../../src/v2/index.ts";

/**
 * Round 7e: the bounded round Astra's contract review asked for.
 *
 * Every test here started as one of its eighteen characterisation probes,
 * which asserted the defect. They now assert the corrected behaviour, so a
 * regression to the reviewed head fails here by name. Two policy tests at
 * the end record the authority-transfer decision: a continuation runs as
 * the identity that parked, restored, and the resumer is data on it.
 */

const temp = (name: string) => mkdtempSync(join(tmpdir(), `rc-7e-${name}-`));
const parked = (
  expiresAt: number | undefined,
  routeId = "r",
  parkedAt = 0,
): Continuation => ({
  codec: 2,
  routeId,
  site: "s",
  frames: [],
  tail: "x",
  parkedAt,
  ...(expiresAt !== undefined ? { expiresAt } : {}),
  exchange: { id: "e", routeId, body: 1, headers: {} },
});
const observer = (seen: string[], id = "acme.ops") =>
  infrastructure({
    id,
    bind: (c) =>
      c.contribute({
        kind: "handler",
        id: "nag",
        point: "error",
        survival: allRuns,
        handle: (ex, { error }) => {
          seen.push(`${error?.code}:${ex.id}`);
          return { kind: "allow", exchange: ex };
        },
      }),
  });

/**
 * @case notification claim excludes resume
 * @preconditions a waiting record claimed for an expiry notification
 * @expectedResult markResumed loses while the claim holds and wins once the lease released it */
test("a notification claim excludes a resume until the lease releases it", async () => {
  const db = new SqliteRecords(":memory:"),
    store = durableStore(db);
  await store.create("e#1", parked(1));
  expect(await store.claimExpiry("e#1", 2)).toBe("won");
  expect(await store.markResumed("e#1", 3)).toBe("lost");
  expect(await store.releaseClaims(2)).toBe(1);
  expect(await store.markResumed("e#1", 4)).toBe("won");
  db.close();
});

/**
 * @case overdue arrival
 * @preconditions a route parked with a deadline already past and no sweep has run
 * @expectedResult the resume expires the record itself, delivers the nag once, and the suffix never runs */
test("a resume that arrives after the deadline expires the record instead of running it", async () => {
  const seen: string[] = [];
  let ran = 0;
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    observer(seen),
  ]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("a", -1)
      .transform(() => ++ran)
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", 0)).deferrals[0]!;
  await expect(app.runtime.resume(id)).rejects.toThrow("EXPIRED");
  expect(ran).toBe(0);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toStartWith("EXPIRED:");
  expect((await app.host.service(CONTINUATIONS).get(id))?.state).toBe(
    "expired",
  );
  await expect(app.runtime.resume(id)).rejects.toThrow("RESUME_SETTLED");
  expect(seen).toHaveLength(1);
  await app.stop();
});

/**
 * @case refusal leaves the approval usable
 * @preconditions a protected route parked under alice; a resume without identity, then alice's
 * @expectedResult the identity-free resume is refused before the record leaves waiting; alice's resume runs it; a repeat is a duplicate */
test("an authorization refusal at the door does not consume the approval", async () => {
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
      .authorize("pay")
      .from(manual)
      .defer("a")
      .transform(() => "paid")
      .build(),
  ]);
  const alice = withPrincipal(
    {},
    { subject: "alice", grants: ["pay"], lent: [] },
  );
  const id = (await app.runtime.deliver("r", 0, alice)).deferrals[0]!;
  const store = app.host.service(CONTINUATIONS);
  expect((await app.runtime.resume(id)).status).toBe("refused");
  expect(await store.get(id)).toMatchObject({ state: "waiting" });
  expect((await store.get(id))?.claimedAt).toBeUndefined();
  expect(
    (await app.runtime.resume(id, { headers: alice })).exchanges[0]?.body,
  ).toBe("paid");
  const again = await app.runtime.resume(id, { headers: alice });
  expect(again.status).toBe("duplicate");
  expect(again.exchanges[0]?.body).toBe("paid");
  await app.stop();
});

/**
 * @case duplicates go through the door and carry the cached outcome
 * @preconditions a resumed suffix that failed; an admission handler counting calls
 * @expectedResult the duplicate is admitted like any resume and reports the cached failure */
test("a duplicate passes admission and exposes how the first resume ended", async () => {
  let admitted = 0,
    allow = true;
  const guard = infrastructure({
    id: "audit",
    bind(c) {
      c.contribute({
        kind: "handler",
        id: "h",
        point: "admission",
        survival: allRuns,
        handle(ex) {
          admitted++;
          return allow
            ? { kind: "allow", exchange: ex }
            : { kind: "refuse", reason: "closed" };
        },
      });
    },
  });
  const app = application([operations, deferral, sqlite(":memory:"), guard]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("a")
      .transform(() => {
        throw Error("payment failed");
      })
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", 0)).deferrals[0]!;
  await expect(app.runtime.resume(id)).rejects.toThrow("payment failed");
  const before = admitted;
  const duplicate = await app.runtime.resume(id);
  expect(admitted).toBe(before + 1);
  expect(duplicate.status).toBe("duplicate");
  expect(duplicate.outcome?.status).toBe("failed");
  expect(duplicate.outcome?.error).toContain("payment failed");
  // A refused caller learns nothing about the record: not even that it was already resumed.
  allow = false;
  expect((await app.runtime.resume(id)).status).toBe("refused");
  await app.stop();
});

/** A vendor's authority: its own header, its own brand, nothing shared with the default provider. */
function vendorAuthority() {
  const branded = new WeakSet<object>();
  const HEADER = "vendor.jwt";
  let reads = 0;
  const token = (subject: string, grants: string[]) => {
    const t = Object.freeze({ subject, grants: Object.freeze(grants) });
    branded.add(t);
    return { [HEADER]: t };
  };
  const authority: Authority = {
    principalOf(headers) {
      reads++;
      const raw = headers[HEADER];
      if (typeof raw !== "object" || raw === null) return undefined;
      const t = raw as { subject: string; grants: readonly string[] };
      return {
        subject: t.subject,
        grants: t.grants,
        lent: [],
        authentic: branded.has(raw),
      };
    },
    refOf(headers) {
      const raw = headers[HEADER] as { subject: string } | undefined;
      return raw ? { subject: raw.subject } : undefined;
    },
  };
  const plugin = infrastructure({
    id: "vendor.jwt",
    provides: [AUTHORITY],
    replaces: [AUTHORITY],
    bind: (c) => c.provide(AUTHORITY, authority),
  });
  return { plugin, token, reads: () => reads };
}

/**
 * @case authority replaced under its own brand
 * @preconditions the default provider and a vendor replacement both installed, a route gated on a grant
 * @expectedResult the gate and the facet consult the selected vendor: its token passes, the default mint is refused */
test("an independently branded authority replaces what the gate and the facet trust", async () => {
  const vendor = vendorAuthority();
  const app = application([operations, principals, auth, vendor.plugin]);
  await app.start([
    app
      .route("r")
      .authorize("pay")
      .from(manual)
      .transform(
        (_, ex) =>
          `${ex.auth.principal?.subject}:${ex.auth.principal?.authentic}`,
      )
      .build(),
  ]);
  expect(app.host.selected.get(AUTHORITY.key)?.plugin.id).toBe("vendor.jwt");
  expect(
    (
      await app.runtime.deliver(
        "r",
        0,
        withPrincipal({}, { subject: "local", grants: ["pay"], lent: [] }),
      )
    ).status,
  ).toBe("refused");
  expect(
    (await app.runtime.deliver("r", 0, vendor.token("jwt-user", ["pay"])))
      .exchanges[0]?.body,
  ).toBe("jwt-user:true");
  expect(vendor.reads()).toBeGreaterThan(0);
  // A copy of a vendor token is a shape the vendor's brand has never seen.
  const copied: Record<string, unknown> = {
    "vendor.jwt": { ...vendor.token("jwt-user", ["pay"])["vendor.jwt"] },
  };
  expect((await app.runtime.deliver("r", 0, copied)).status).toBe("refused");
  await app.stop();
  // The gate needs an authority; declining every provider is a boot failure, not a fail-open.
  expect(() => application([operations, auth])).toThrow("MISSING_PORT");
});

/**
 * @case the ask names enforcement, not authority
 * @preconditions a route built with `.authorize()`, started where only an authority provider is installed, under the gate's namespace or not
 * @expectedResult the route refuses to compile, so nothing runs unprotected */
test("a provider without the gate satisfies nothing: the route requirement is the enforcement port", async () => {
  const author = application([operations, principals, auth]);
  const spec = author
    .route("r")
    .authorize("pay")
    .from(manual)
    .transform(() => "paid")
    .build();
  expect(spec.requires?.map((p) => p.name)).toEqual([ENFORCEMENT.name]);
  await expect(
    application([operations, principals]).start([spec]),
  ).rejects.toThrow("ROUTE_REQUIRES");
  const impostor = infrastructure({
    id: "vendor.impostor",
    namespace: "auth",
    provides: [AUTHORITY],
    bind: (c) =>
      c.provide(AUTHORITY, {
        principalOf: () => undefined,
        refOf: () => undefined,
      }),
  });
  await expect(
    application([operations, impostor]).start([spec]),
  ).rejects.toThrow("ROUTE_REQUIRES");
});

/**
 * @case the persistence codec is the shipped one
 * @preconditions a Map body and a Date body parked through SQLite
 * @expectedResult the Map is refused at the defer boundary by path; the Date comes back a Date */
test("a Map cannot park and a Date round-trips as a Date", async () => {
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("a")
      .transform((x) => x)
      .build(),
  ]);
  await expect(
    app.runtime.deliver("r", { amount: new Map([["x", 1]]) }),
  ).rejects.toThrow("NOT_PERSISTABLE: body.amount holds an instance of Map");
  const when = new Date("2026-01-01T00:00:00.000Z");
  const id = (await app.runtime.deliver("r", { when })).deferrals[0]!;
  const body = (await app.runtime.resume(id)).exchanges[0]?.body as {
    when: unknown;
  };
  expect(body.when).toBeInstanceOf(Date);
  expect((body.when as Date).toISOString()).toBe(when.toISOString());
  await app.stop();
});

/**
 * @case terminal body the cache cannot hold
 * @preconditions a resumed suffix that performs its effect and returns a function
 * @expectedResult the resume completes, the completion is recorded without the body, a duplicate learns it completed, nothing is stranded */
test("an unpersistable terminal body does not turn a completion into a failure", async () => {
  let paid = 0;
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("a")
      .transform(() => {
        paid++;
        return () => 1;
      })
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", 0)).deferrals[0]!;
  const result = await app.runtime.resume(id);
  expect(result.status).toBe("completed");
  expect(typeof result.exchanges[0]?.body).toBe("function");
  expect(paid).toBe(1);
  const store = app.host.service(CONTINUATIONS);
  expect((await store.get(id))?.outcome).toEqual({
    status: "completed",
    exchanges: [],
    omitted: 1,
  });
  expect(await store.resumedWithoutOutcome()).toEqual([]);
  const again = await app.runtime.resume(id);
  expect(again.status).toBe("duplicate");
  expect(again.outcome?.status).toBe("completed");
  expect(paid).toBe(1);
  await app.stop();
});

/** A tail step whose target is a callback nested inside a declared option object. */
function payout(target: () => string) {
  const option = { target };
  return {
    ...instruction("routecraft.operations", "payout", (ex) => ({
      kind: "continue",
      exchange: { ...ex, body: option.target() },
    })),
    source: [option],
  };
}

/**
 * @case nested callable in declared source
 * @preconditions an exchange parked under a tail whose option object holds a callback, then that callback edited
 * @expectedResult the unchanged option resumes; the edited callback is refused and the record denied */
test("a callback nested in a step's declared source is part of the tail hash", async () => {
  const build = async (target: () => string) => {
    const app = application([operations, deferral, sqlite(":memory:")]);
    const spec = app.route("r").from(manual).defer("a").build();
    await app.start([{ ...spec, steps: [...spec.steps, payout(target)] }]);
    return app;
  };
  const a = await build(() => "bank-a");
  const id = (await a.runtime.deliver("r", 0)).deferrals[0]!;
  const record = (await a.host.service(CONTINUATIONS).get(id))!.continuation;
  const same = await build(() => "bank-a");
  await same.host.service(CONTINUATIONS).create(id, record);
  expect((await same.runtime.resume(id)).exchanges[0]?.body).toBe("bank-a");
  const edited = await build(() => "bank-b");
  await edited.host.service(CONTINUATIONS).create(id, record);
  await expect(edited.runtime.resume(id)).rejects.toThrow("PLAN_MISMATCH");
  expect((await edited.host.service(CONTINUATIONS).get(id))?.state).toBe(
    "denied",
  );
  await Promise.all([a.stop(), same.stop(), edited.stop()]);
});

/**
 * @case the scan sees only what it may act on, and pages past what it visited
 * @preconditions 101 due records of which the oldest 100 are claimed; then 150 unclaimed due records
 * @expectedResult the claimed page is not returned so the free record is; a cursor starts the next page strictly after the last visited */
test("findExpired excludes claimed records and pages by keyset cursor", async () => {
  const db = new SqliteRecords(":memory:"),
    store = durableStore(db);
  const id = (i: number) => String(i).padStart(3, "0");
  for (let i = 0; i < 101; i++) {
    await store.create(id(i), parked(i));
    if (i < 100) await store.claimExpiry(id(i), 200);
  }
  expect((await store.findExpired(200, 100)).map((x) => x.id)).toEqual(["100"]);
  const many = durableStore(new SqliteRecords(":memory:"));
  for (let i = 0; i < 150; i++) await many.create(id(i), parked(i % 3));
  const first = await many.findExpired(10, 100);
  expect(first).toHaveLength(100);
  const second = await many.findExpired(10, 100, first[99]);
  expect(second).toHaveLength(50);
  expect(new Set([...first, ...second].map((x) => x.id)).size).toBe(150);
  await expect(many.findExpired(10, 0)).rejects.toThrow("SCAN_LIMIT");
  db.close();
});

/**
 * @case protected route expiry
 * @preconditions a route gated on a grant parked under an authentic identity, past its deadline
 * @expectedResult the sweep reaches the error channel with the restored exchange: the nag is delivered and the record expires */
test("expiry on a protected route reaches its error channel", async () => {
  const seen: string[] = [];
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    principals,
    auth,
    observer(seen),
  ]);
  await app.start([
    app.route("r").authorize("pay").from(manual).defer("a", -1).build(),
  ]);
  const id = (
    await app.runtime.deliver(
      "r",
      0,
      withPrincipal({}, { subject: "a", grants: ["pay"], lent: [] }),
    )
  ).deferrals[0]!;
  expect((await app.runtime.sweep()).retired).toBe(1);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toStartWith("EXPIRED:");
  expect((await app.host.service(CONTINUATIONS).get(id))?.state).toBe(
    "expired",
  );
  await app.stop();
});

const CUSTOM: unique symbol = Symbol("review read-only");
const OTHER: unique symbol = Symbol("another owner");
declare module "../../src/v2/contracts.ts" {
  interface HandlerPoints {
    "review:read": {
      readonly owner: typeof CUSTOM;
      readonly refuse: false;
      readonly defer: false;
    };
  }
}
/**
 * @case refusal policy of an external point at runtime
 * @preconditions a plugin-declared point that honours no refusal, a JavaScript handler refusing at it; a contribution to an undeclared point; two declarations of one name
 * @expectedResult the refusal is a named fault, the undeclared point is refused at bind, the second declaration is refused at construction */
test("an external point's refusal policy is enforced at runtime, not only by the compiler", async () => {
  const plugin = infrastructure({
    id: "review",
    points: [point("review:read", CUSTOM, false, false)],
    bind(c) {
      c.contribute({
        kind: "handler",
        id: "bad",
        point: "review:read",
        survival: allRuns,
        handle: (() => ({
          kind: "refuse",
          reason: "no",
        })) as unknown as Handler<"review:read">["handle"],
      });
    },
  });
  const app = application([operations, plugin]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .step("invoke", async (ex, ctx) => {
        await ctx.invoke("review:read", ex);
        return { kind: "continue", exchange: ex };
      })
      .build(),
  ]);
  await expect(app.runtime.deliver("r", 0)).rejects.toThrow(
    "[review] REFUSE_UNSUPPORTED: review:read: bad",
  );
  await app.stop();
  await expect(
    application([
      infrastructure({
        id: "undeclared",
        bind: (c) =>
          c.contribute({
            kind: "handler",
            id: "h",
            point: "review:read",
            survival: allRuns,
            handle: (ex) => ({ kind: "allow", exchange: ex }),
          }),
      }),
    ]).start([]),
  ).rejects.toThrow("UNKNOWN_POINT");
  expect(() =>
    application([
      plugin,
      infrastructure({
        id: "other",
        points: [
          point("review:read", OTHER as unknown as typeof CUSTOM, false, false),
        ],
      }),
    ]),
  ).toThrow("POINT_IDENTITY");
});

/**
 * @case exit decoration
 * @preconditions two exit handlers, the first replacing the body
 * @expectedResult the second sees the decoration and so does the caller */
test("exit decoration reaches the returned result", async () => {
  let seen: unknown;
  const plugin = infrastructure({
    id: "review",
    bind(c) {
      c.contribute({
        kind: "handler",
        id: "a",
        point: "exit",
        survival: allRuns,
        handle: (ex) => ({
          kind: "allow",
          exchange: { ...ex, body: "decorated" },
        }),
      });
      c.contribute({
        kind: "handler",
        id: "b",
        point: "exit",
        survival: allRuns,
        handle(ex) {
          seen = ex.body;
          return { kind: "allow", exchange: ex };
        },
      });
    },
  });
  const app = application([operations, plugin]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .transform((x) => x)
      .build(),
  ]);
  const result = await app.runtime.deliver("r", "original");
  expect(seen).toBe("decorated");
  expect(result.exchanges[0]?.body).toBe("decorated");
  await app.stop();
});

const tailStep = (id: string, body: string) =>
  instruction("routecraft.operations", id, (ex) => ({
    kind: "continue",
    exchange: { ...ex, body },
  }));
/**
 * @case the live tail is what is compared
 * @preconditions an exchange parked before a payment step; a deployment that appends an audit step after it; one that inserts a step before the defer point
 * @expectedResult the unchanged tail resumes; the appended step is refused and the record denied with the route told; the earlier insertion is refused too, because step addresses are positional */
test("a step appended after the defer point invalidates the approval", async () => {
  const build = async (shape: "same" | "appended" | "prefixed") => {
    const seen: string[] = [];
    const app = application([
      operations,
      deferral,
      sqlite(":memory:"),
      observer(seen),
    ]);
    let chain = app.route("r").from(manual);
    if (shape === "prefixed") chain = chain.transform((x) => x);
    const spec = chain.defer("a").build();
    const steps = [...spec.steps, tailStep("pay", "pay")];
    if (shape === "appended") steps.push(tailStep("audit", "audit"));
    await app.start([{ ...spec, steps }]);
    return { app, seen };
  };
  const origin = await build("same");
  const id = (await origin.app.runtime.deliver("r", 0)).deferrals[0]!;
  const record = (await origin.app.host.service(CONTINUATIONS).get(id))!
    .continuation;
  const same = await build("same");
  await same.app.host.service(CONTINUATIONS).create(id, record);
  expect((await same.app.runtime.resume(id)).exchanges[0]?.body).toBe("pay");
  const appended = await build("appended");
  await appended.app.host.service(CONTINUATIONS).create(id, record);
  await expect(appended.app.runtime.resume(id)).rejects.toThrow(
    "PLAN_MISMATCH",
  );
  expect(appended.seen).toEqual([`PLAN_MISMATCH:${record.exchange.id}`]);
  expect((await appended.app.host.service(CONTINUATIONS).get(id))?.state).toBe(
    "denied",
  );
  const prefixed = await build("prefixed");
  await prefixed.app.host.service(CONTINUATIONS).create(id, record);
  await expect(prefixed.app.runtime.resume(id)).rejects.toThrow(
    "PLAN_MISMATCH",
  );
  await Promise.all([
    origin.app.stop(),
    same.app.stop(),
    appended.app.stop(),
    prefixed.app.stop(),
  ]);
});

/**
 * @case a defer point with nothing after it
 * @preconditions an exchange parked at the last step, then a deployment that appends a step
 * @expectedResult the empty tail resumes as empty; the appended step is refused, because the frame is anchored at the site */
test("an appended step after a trailing defer point is not silently skipped", async () => {
  const build = async (append: boolean) => {
    const app = application([operations, deferral, sqlite(":memory:")]);
    const spec = app.route("r").from(manual).defer("a").build();
    await app.start([
      {
        ...spec,
        steps: append ? [...spec.steps, tailStep("late", "late")] : spec.steps,
      },
    ]);
    return app;
  };
  const a = await build(false),
    b = await build(true);
  const id = (await a.runtime.deliver("r", 7)).deferrals[0]!;
  const record = (await a.host.service(CONTINUATIONS).get(id))!.continuation;
  expect(record.frames).toEqual([{ list: null, from: 1 }]);
  expect((await a.runtime.resume(id)).exchanges[0]?.body).toBe(7);
  await b.host.service(CONTINUATIONS).create(id, record);
  await expect(b.runtime.resume(id)).rejects.toThrow("PLAN_MISMATCH");
  await Promise.all([a.stop(), b.stop()]);
});

/**
 * @case boot reporting and healing
 * @preconditions a store holding a resumed record with no outcome, an overdue waiting record, and a stale claim
 * @expectedResult the deferral plugin's start releases the claim, retires the overdue record into its route's error channel, and reports the stranded id */
test("boot scans the store: stale claims released, overdue work retired, stranded residue reported", async () => {
  const dir = temp("boot");
  try {
    const db = new SqliteRecords(join(dir, "d.db")),
      store = durableStore(db);
    await store.create("stranded#1", parked(undefined));
    // Settled within retention: a stranded record older than that is purged, as shipped.
    await store.markResumed("stranded#1", Date.now());
    await store.create("overdue#1", parked(1));
    await store.create("stale#1", parked(1));
    await store.claimExpiry("stale#1", 1);
    db.close();
    const events: { name: string; data: unknown }[] = [];
    const seen: string[] = [];
    const app = application([
      operations,
      deferralPlugin({ lease: 1000, interval: 0 }),
      sqlite(join(dir, "d.db")),
      observer(seen),
      infrastructure({
        id: "acme.log",
        bind: (c) => c.observe((e) => events.push(e)),
      }),
    ]);
    await app.start([app.route("r").from(manual).defer("a").build()]);
    const boot = events.find((e) => e.name === "deferral:boot")?.data as {
      released: number;
      retired: number;
      stranded: string[];
      pending: { count: number };
    };
    expect(boot).toMatchObject({
      released: 1,
      retired: 2,
      stranded: ["stranded#1"],
      pending: { count: 0 },
    });
    expect(seen.sort()).toEqual(["EXPIRED:e", "EXPIRED:e"]);
    await app.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * @case orphans do not starve the sweep
 * @preconditions an overdue record for a route this application lacks, ahead of one for a present route
 * @expectedResult the orphan is counted and left unclaimed; the present route's record is retired */
test("an orphaned record is skipped, unclaimed, and the sweep continues past it", async () => {
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([app.route("r").from(manual).defer("a", -1).build()]);
  const store = app.host.service(CONTINUATIONS);
  await store.create("orphan#1", parked(0, "removed-route"));
  await store.create("future#1", parked(Date.now() + 1_000_000));
  const id = (await app.runtime.deliver("r", 0)).deferrals[0]!;
  const report = await app.runtime.sweep();
  expect(report).toMatchObject({
    visited: 2,
    retired: 1,
    orphans: { "removed-route": 1 },
  });
  expect((await store.get("future#1"))?.state).toBe("waiting");
  expect((await store.get("orphan#1"))?.claimedAt).toBeUndefined();
  expect((await store.get(id))?.state).toBe("expired");
  await app.stop();
});

/**
 * @case step-owned state across the wait
 * @preconditions a re-entrant step that parks with state holding a Date, resumes, and parks again without state
 * @expectedResult the state comes back to that step alone on the resume, Date intact, and the second deferral carries none */
test("step state is handed back to the step that parked and does not leak into the next deferral", async () => {
  const seen: unknown[] = [];
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .step("ask", (ex, ctx): StepOutcome => {
        seen.push(ctx.stepState);
        if (ctx.kind !== "resume")
          return {
            kind: "defer",
            exchange: ex,
            request: {
              name: "first",
              reason: "x",
              reenter: true,
              state: { turn: 1, at: new Date("2026-01-01T00:00:00.000Z") },
            },
          };
        if (ctx.stepState !== undefined)
          return {
            kind: "defer",
            exchange: ex,
            request: { name: "second", reason: "x", reenter: true },
          };
        return { kind: "continue", exchange: ex };
      })
      .transform((_, ex) => seen.push(ex.headers))
      .build(),
  ]);
  const first = (await app.runtime.deliver("r", 0)).deferrals[0]!;
  const store = app.host.service(CONTINUATIONS);
  expect((await store.get(first))?.continuation.stepState).toEqual({
    turn: 1,
    at: { $date: "2026-01-01T00:00:00.000Z" },
  });
  const second = (await app.runtime.resume(first)).deferrals[0]!;
  expect((await store.get(second))?.continuation.stepState).toBeUndefined();
  expect((await app.runtime.resume(second)).status).toBe("completed");
  expect(seen[0]).toBeUndefined();
  expect(seen[1]).toEqual({
    turn: 1,
    at: new Date("2026-01-01T00:00:00.000Z"),
  });
  expect((seen[1] as { at: unknown }).at).toBeInstanceOf(Date);
  expect(seen[2]).toBeUndefined();
  expect(Object.keys(seen[3] as object)).not.toContain("stepState");
  await app.stop();
});

/**
 * @case the store's settlement surface
 * @preconditions a denied record, a purge cutoff, a step-state replacement with the right and the wrong fingerprint, and a claimed record
 * @expectedResult denial stamps settledAt and reason; purge removes only settled records past the cutoff; the replacement wins once and loses against a stale fingerprint or a claim; pending reports the oldest */
test("denial, retention, step-state replacement and the pending summary", async () => {
  const db = new SqliteRecords(":memory:"),
    store = durableStore(db);
  await store.create("a#1", { ...parked(1, "r", 5), stepState: { n: 1 } });
  await store.create("b#1", parked(1, "r", 3));
  expect(await store.pending()).toEqual({ count: 2, oldest: 3 });
  expect(await store.markDenied("a#1", 9, "changed")).toBe("lost");
  expect(await store.markExpired("a#1", 9)).toBe("lost");
  expect(await store.claimExpiry("a#1", 8)).toBe("won");
  expect(await store.markDenied("a#1", 9, "changed")).toBe("won");
  expect(await store.get("a#1")).toMatchObject({
    state: "denied",
    settledAt: 9,
    reason: "changed",
  });
  expect(await store.pending()).toEqual({ count: 1, oldest: 3 });
  expect(await store.purgeSettled(9)).toBe(0);
  expect(await store.purgeSettled(10)).toBe(1);
  expect(await store.get("a#1")).toBeUndefined();
  expect(await store.get("b#1")).toMatchObject({ state: "waiting" });
  expect(
    await store.replaceStepState("b#1", fingerprint({ stale: true }), { n: 2 }),
  ).toBe("lost");
  expect(
    await store.replaceStepState("b#1", fingerprint(undefined), { n: 2 }),
  ).toBe("won");
  expect((await store.get("b#1"))?.continuation.stepState).toEqual({ n: 2 });
  await store.claimExpiry("b#1", 1);
  expect(
    await store.replaceStepState("b#1", fingerprint({ n: 2 }), { n: 3 }),
  ).toBe("lost");
  db.close();
});

/**
 * @case the sweep runs on a timer
 * @preconditions the deferral plugin installed with a short interval, an exchange parked with a short ttl
 * @expectedResult the record expires without anyone calling sweep */
test("the deferral plugin's timer retires an expired record on its own", async () => {
  const app = application([
    operations,
    deferralPlugin({ interval: 20 }),
    sqlite(":memory:"),
  ]);
  await app.start([app.route("r").from(manual).defer("a", 1).build()]);
  const id = (await app.runtime.deliver("r", 0)).deferrals[0]!;
  const store = app.host.service(CONTINUATIONS);
  const end = Date.now() + 2000;
  while ((await store.get(id))?.state === "waiting" && Date.now() < end)
    await new Promise((r) => setTimeout(r, 10));
  expect((await store.get(id))?.state).toBe("expired");
  await app.stop();
});

const sink = (app: ReturnType<typeof gatedApp>) =>
  app
    .route("sink")
    .authorize("approve")
    .from(manual)
    .transform(
      (_, ex) =>
        `${ex.auth.principal?.subject}:${ex.auth.principal?.authentic}`,
    )
    .build();
const gatedApp = () =>
  application([operations, deferral, sqlite(":memory:"), principals, auth]);

/**
 * @case authority does not transfer on resume
 * @preconditions alice parks an exchange; bob resumes it with his live identity and an extra ingress header
 * @expectedResult the continuation runs as alice, restored; bob is readable as resumedBy and as data on the ingress header, never as a credential; a downstream gate refuses the continuation; an explicit re-mint in the continuation passes it */
test("a resumed continuation keeps the parked identity restored and records the resumer as data", async () => {
  const app = gatedApp();
  const hop = (remint: boolean) =>
    app
      .route(remint ? "minted" : "plain")
      .from(manual)
      .defer("approval")
      .step("hop", async (ex, ctx) => {
        const carried = remint
          ? {
              ...ex,
              headers: withPrincipal(ex.headers, {
                subject: "service",
                grants: ["approve"],
                lent: [],
              }),
            }
          : ex;
        const view = ex.auth;
        return {
          kind: "continue",
          exchange: {
            ...ex,
            body: {
              principal: `${view.principal?.subject}:${view.principal?.authentic}`,
              resumedBy: view.resumedBy?.subject,
              note: ex.headers["note"],
              recorded: ex.headers[DEFERRAL_RESUMED_BY],
              sink: (await ctx.dispatch("sink", carried)).status,
            },
          },
        };
      })
      .build();
  await app.start([sink(app), hop(false), hop(true)]);
  const alice = withPrincipal(
    {},
    { subject: "alice", grants: [], lent: ["approve"] },
  );
  const bob = withPrincipal(
    { note: "from bob" },
    { subject: "bob", grants: ["approve"], lent: [] },
  );
  const plain = (await app.runtime.deliver("plain", 0, alice)).deferrals[0]!;
  expect(
    (await app.runtime.resume(plain, { headers: bob })).exchanges[0]?.body,
  ).toEqual({
    principal: "alice:false",
    resumedBy: "bob",
    note: undefined,
    recorded: { auth: { resumedBy: { subject: "bob" } } },
    sink: "refused",
  });
  const minted = (await app.runtime.deliver("minted", 0, alice)).deferrals[0]!;
  expect(
    (
      (await app.runtime.resume(minted, { headers: bob })).exchanges[0]
        ?.body as {
        sink: string;
      }
    ).sink,
  ).toBe("completed");
  // The stored principal object is a parse the brand has never seen, even in the process that minted it.
  const store = app.host.service(CONTINUATIONS);
  const stored = (await store.get(plain))!.continuation.exchange.headers[
    PRINCIPAL_HEADER
  ];
  expect(stored).toMatchObject({ subject: "alice" });
  expect(mint({ subject: "x", grants: [], lent: [] })).not.toBe(stored);
  await app.stop();
});

/**
 * @case the door sees the ingress and what it would revive
 * @preconditions an admission handler recording what it is given on a resume
 * @expectedResult at a resume the handler sees the ingress payload and headers as the exchange, and the parked exchange under info.resume; the continuation gets the payload as its result header */
test("admission at a resume is over the ingress, with the parked exchange beside it", async () => {
  const seen: unknown[] = [];
  const door = infrastructure({
    id: "acme.door",
    bind: (c) =>
      c.contribute({
        kind: "handler",
        id: "door",
        point: "admission",
        survival: allRuns,
        handle(ex, info) {
          if (info.kind === "resume")
            seen.push({
              body: ex.body,
              headers: ex.headers,
              id: info.resume?.id,
              view: Object.keys(info.resume ?? {}).sort(),
              parkedHeaders: info.resume?.headers,
            });
          return { kind: "allow", exchange: ex };
        },
      }),
  });
  const app = application([operations, deferral, sqlite(":memory:"), door]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("a")
      .transform((body, ex) => [body, ex.headers["routecraft.deferral.result"]])
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", "parked-body")).deferrals[0]!;
  const result = await app.runtime.resume(id, {
    payload: { approved: true },
    headers: { via: "slack" },
  });
  expect(result.exchanges[0]?.body).toEqual([
    "parked-body",
    { approved: true },
  ]);
  expect(seen).toEqual([
    {
      body: { approved: true },
      headers: { via: "slack" },
      id,
      view: [
        "expiresAt",
        "headers",
        "id",
        "parkedAt",
        "payload",
        "routeId",
        "site",
      ],
      parkedHeaders: { "routecraft.deferral.sequence": 1 },
    },
  ]);
  await app.stop();
});

/**
 * @case a minted principal is immutable
 * @preconditions a step holding an authentic principal through the facet
 * @expectedResult it cannot add a grant to it, so the credential it was handed is the credential the gate sees */
test("a minted principal is immutable, so a step cannot escalate the credential it holds", async () => {
  const app = application([operations, principals, auth]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .transform((_, ex) => {
        const grants = ex.auth.principal!.grants as string[];
        try {
          grants.push("approve");
          return "escalated";
        } catch {
          return "frozen";
        }
      })
      .build(),
  ]);
  const p = mint({ subject: "eve", grants: [], lent: [] });
  expect(
    (await app.runtime.deliver("r", 0, { [PRINCIPAL_HEADER]: p })).exchanges[0]
      ?.body,
  ).toBe("frozen");
  expect(Object.isFrozen(p.grants)).toBe(true);
  await app.stop();
});

/**
 * @case a child step in the tail
 * @preconditions an exchange parked before a branching step whose child callable is then edited
 * @expectedResult the edited child is refused, because declared children are part of the tail's definition */
test("an edited child of a branching step in the tail invalidates the approval", async () => {
  // The child callable's TEXT is what changes between deployments; a captured variable would not move the hash.
  const build = async (leafFn: (ex: Exchange) => StepOutcome) => {
    const app = application([operations, deferral, sqlite(":memory:")]);
    const leaf = instruction("routecraft.operations", "leaf", leafFn);
    const branch = instruction(
      "routecraft.operations",
      "branch",
      (ex) => ({ kind: "branch", exchange: ex, steps: [leaf] }),
      [leaf],
    );
    const spec = app.route("r").from(manual).defer("a").build();
    await app.start([{ ...spec, steps: [...spec.steps, branch] }]);
    return app;
  };
  const a = await build((ex) => ({
    kind: "continue",
    exchange: { ...ex, body: "left" },
  }));
  const id = (await a.runtime.deliver("r", 0)).deferrals[0]!;
  const record = (await a.host.service(CONTINUATIONS).get(id))!.continuation;
  const same = await build((ex) => ({
    kind: "continue",
    exchange: { ...ex, body: "left" },
  }));
  await same.host.service(CONTINUATIONS).create(id, record);
  expect((await same.runtime.resume(id)).exchanges[0]?.body).toBe("left");
  const edited = await build((ex) => ({
    kind: "continue",
    exchange: { ...ex, body: "right" },
  }));
  await edited.host.service(CONTINUATIONS).create(id, record);
  await expect(edited.runtime.resume(id)).rejects.toThrow("PLAN_MISMATCH");
  await Promise.all([a.stop(), same.stop(), edited.stop()]);
});

/**
 * @case two sweeps on one page
 * @preconditions one overdue record, two sweeps started together so both read it as due
 * @expectedResult exactly one wins the claim and delivers the nag; the other retires nothing */
test("concurrent sweeps deliver one nag, because the claim is exclusive", async () => {
  const seen: string[] = [];
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    observer(seen),
  ]);
  await app.start([app.route("r").from(manual).defer("a", -1).build()]);
  await app.runtime.deliver("r", 0);
  const [a, b] = await Promise.all([app.runtime.sweep(), app.runtime.sweep()]);
  expect(a.retired + b.retired).toBe(1);
  expect(seen).toHaveLength(1);
  await app.stop();
});
