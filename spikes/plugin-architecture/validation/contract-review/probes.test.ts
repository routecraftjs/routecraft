/** Characterizations of the reviewed baseline, not desired acceptance behavior. */
import { test, expect } from "bun:test";
import {
  application,
  infrastructure,
  operations,
  deferral,
  sqlite,
  manual,
  auth,
  AUTHORITY,
  withPrincipal,
  CONTINUATIONS,
  SqliteRecords,
  durableStore,
  allRuns,
  instruction,
  type Continuation,
  type Exchange,
  type Handler,
} from "../../src/v2/index.ts";
import { MemoryDeferralStore } from "../../../../packages/routecraft/src/deferral/memory-store.ts";
import { encodePersistable } from "../../../../packages/routecraft/src/deferral/serialize.ts";
import {
  continuationTailHash,
  describeSchema,
} from "../../../../packages/routecraft/src/deferral/hash.ts";

const saved = (expiresAt = 1, routeId = "r"): Continuation => ({
  codec: 1,
  routeId,
  tail: "x",
  pending: [],
  expiresAt,
  exchange: { id: "e", routeId, body: 1, headers: {} },
});

/**
 * @case independent review probe 1
 * @preconditions Both stores contain a waiting record claimed for notification
 * @expectedResult Only the shipped store refuses markResumed
 */
test("review: an expiry claim does not exclude resume, unlike shipped store", async () => {
  const db = new SqliteRecords(":memory:");
  const s = durableStore(db);
  await s.create("e#1", saved());
  expect(await s.claimExpiry("e#1", 2)).toBe("won");
  expect(await s.markResumed("e#1", 3)).toBe("won");
  const shipped = new MemoryDeferralStore();
  await shipped.create({
    id: "e#1",
    routeId: "r",
    position: 0,
    continuationHash: "x",
    actionFingerprint: "x",
    exchange: { body: 1, headers: {} },
    schema: { hash: "x" },
    deferredAt: new Date(0),
    expiresAt: new Date(1),
    waitingFor: "resume",
  });
  expect((await shipped.claimExpiry("e#1", new Date(2))).won).toBe(true);
  expect((await shipped.markResumed("e#1", { at: new Date(3) })).won).toBe(
    false,
  );
  db.close();
});

/**
 * @case independent review probe 2
 * @preconditions A route parks with a deadline in the past
 * @expectedResult The spike still executes its payment suffix
 */
test("review: a past-deadline continuation still executes without a sweep", async () => {
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("a", -1)
      .transform(() => "paid")
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", 0)).deferrals[0]!;
  expect((await app.runtime.resume(id)).exchanges[0]?.body).toBe("paid");
  await app.stop();
});

/**
 * @case independent review probe 3
 * @preconditions A protected route parks under an authentic identity
 * @expectedResult An identity-free resume refuses after consuming the record
 */
test("review: entry authorization refusal consumes a waiting approval", async () => {
  const app = application([operations, deferral, sqlite(":memory:"), auth]);
  await app.start([
    app
      .route("r")
      .authorize("pay")
      .from(manual)
      .defer("a")
      .transform(() => "paid")
      .build(),
  ]);
  const ingress = withPrincipal(
    {},
    { subject: "alice", grants: ["pay"], lent: [] },
  );
  const id = (await app.runtime.deliver("r", 0, ingress)).deferrals[0]!;
  expect((await app.runtime.resume(id)).status).toBe("refused");
  expect((await app.host.service(CONTINUATIONS).get(id))?.state).toBe(
    "resumed",
  );
  expect((await app.runtime.resume(id, ingress)).status).toBe("duplicate");
  await app.stop();
});

/**
 * @case independent review probe 4
 * @preconditions A resumed suffix throws and an admission handler counts calls
 * @expectedResult The duplicate skips admission and omits the cached failure
 */
test("review: duplicate skips admission and loses the cached failure details", async () => {
  let admitted = 0;
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
          return { kind: "allow", exchange: ex };
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
  expect(admitted).toBe(before);
  expect(duplicate).toEqual({
    status: "duplicate",
    exchanges: [],
    deferrals: [],
  });
  expect(
    (await app.host.service(CONTINUATIONS).get(id))?.outcome?.error,
  ).toContain("payment failed");
  await app.stop();
});

/**
 * @case independent review probe 5
 * @preconditions A third party supplies AUTHORITY while the default auth plugin remains installed
 * @expectedResult Provider selection changes but neither handler nor facet consults it
 */
test("review: selected third-party authority is never consulted by the auth handler or facet", async () => {
  let reads = 0;
  const jwt = infrastructure({
    id: "vendor.jwt",
    provides: [AUTHORITY],
    replaces: [AUTHORITY],
    bind(c) {
      c.provide(AUTHORITY, {
        principalOf() {
          reads++;
          return {
            subject: "jwt-user",
            grants: ["pay"],
            lent: [],
            authentic: true,
          };
        },
        effective() {
          reads++;
          return ["pay"];
        },
      });
    },
  });
  const app = application([operations, auth, jwt]);
  await app.start([
    app
      .route("r")
      .authorize("pay")
      .from(manual)
      .transform((_, ex) => ex.auth.principal)
      .build(),
  ]);
  expect(app.host.selected.get(AUTHORITY.key)?.plugin.id).toBe("vendor.jwt");
  expect((await app.runtime.deliver("r", 0)).status).toBe("refused");
  expect(reads).toBe(0);
  expect(
    (
      await app.runtime.deliver(
        "r",
        0,
        withPrincipal({}, { subject: "local", grants: ["pay"], lent: [] }),
      )
    ).status,
  ).toBe("completed");
  expect(reads).toBe(0);
  await app.stop();
});

/**
 * @case independent review probe 6
 * @preconditions A plugin groups identity and conversation under one facet
 * @expectedResult Both members work and a second top-level facet is refused
 */
test("review: one nested facet can expose two independent concerns", async () => {
  const plugin = infrastructure({
    id: "vendor.session",
    facets: {
      session: () => ({
        identity: { subject: "a" },
        conversation: { id: "b" },
      }),
    },
  });
  const app = application([operations, plugin]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .transform((_, ex) => [
        ex.session.identity.subject,
        ex.session.conversation.id,
      ])
      .build(),
  ]);
  expect((await app.runtime.deliver("r", 0)).exchanges[0]?.body).toEqual([
    "a",
    "b",
  ]);
  expect(() =>
    application([
      infrastructure({
        id: "vendor.session",
        facets: { session: () => 1, conversation: () => 2 },
      }),
    ]),
  ).toThrow("FACET_NAMESPACE");
  await app.stop();
});

/**
 * @case independent review probe 7
 * @preconditions A Map and a Date are parked through SQLite
 * @expectedResult The Map loses its entries and the Date becomes a string
 */
test("review: cloneability is not the shipped persistence codec", async () => {
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("a")
      .transform((x) => x)
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", new Map([["amount", 100]])))
    .deferrals[0]!;
  expect((await app.runtime.resume(id)).exchanges[0]?.body).toEqual({});
  expect(() => encodePersistable(new Map([["amount", 100]]), "body")).toThrow(
    "holds an instance of Map",
  );
  const dateId = (await app.runtime.deliver("r", new Date("2026-01-01")))
    .deferrals[0]!;
  expect(typeof (await app.runtime.resume(dateId)).exchanges[0]?.body).toBe(
    "string",
  );
  expect(encodePersistable(new Date("2026-01-01"), "body")).toEqual({
    "$routecraft.date": "2026-01-01T00:00:00.000Z",
  });
  await app.stop();
});

/**
 * @case independent review probe 8
 * @preconditions A resumed suffix performs its effect and returns a function
 * @expectedResult Caching throws and leaves residue despite completed work
 */
test("review: successful non-cloneable terminal body throws after its effect and strands cache", async () => {
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
  await expect(app.runtime.resume(id)).rejects.toThrow("NOT_SERIALIZABLE");
  expect(paid).toBe(1);
  expect(await app.host.service(CONTINUATIONS).resumedWithoutOutcome()).toEqual(
    [id],
  );
  await app.stop();
});

/**
 * @case independent review probe 9
 * @preconditions Deployments change a callback nested in declared step source
 * @expectedResult The spike accepts the edit while the shipped hash changes
 */
test("review: nested callable option edit passes hash unlike shipped hash", async () => {
  const build = (target: () => string) => {
    const app = application([operations, deferral, sqlite(":memory:")]);
    const option = { target };
    const tail = {
      ...instruction("routecraft.operations", "tail", (ex) => ({
        kind: "continue",
        exchange: { ...ex, body: option.target() },
      })),
      source: [option],
    };
    const spec = app.route("r").from(manual).defer("a").build();
    return { app, spec: { ...spec, steps: [...spec.steps, tail] } };
  };
  const a = build(() => "bank-a");
  await a.app.start([a.spec]);
  const id = (await a.app.runtime.deliver("r", 0)).deferrals[0]!;
  const record = (await a.app.host.service(CONTINUATIONS).get(id))!
    .continuation;
  const b = build(() => "bank-b");
  await b.app.start([b.spec]);
  await b.app.host.service(CONTINUATIONS).create(id, record);
  expect((await b.app.runtime.resume(id)).exchanges[0]?.body).toBe("bank-b");
  const hash = (target: () => string) =>
    continuationTailHash(
      [{ operation: "transform", adapter: { options: { target } } }] as never,
      describeSchema(),
    );
  expect(hash(() => "bank-a")).not.toBe(hash(() => "bank-b"));
  await a.app.stop();
  await b.app.stop();
});

/**
 * @case independent review probe 10
 * @preconditions The oldest due page is claimed and another due record follows
 * @expectedResult The query returns claimed records and omits the available record
 */
test("review: claimed oldest page starves unclaimed due record", async () => {
  const db = new SqliteRecords(":memory:");
  const s = durableStore(db);
  for (let i = 0; i < 101; i++) {
    await s.create(String(i).padStart(3, "0"), saved(i));
    if (i < 100) await s.claimExpiry(String(i).padStart(3, "0"), 200);
  }
  const ids = await s.findExpired(200);
  expect(ids).toHaveLength(100);
  expect(ids).not.toContain("100");
  expect((await s.get(ids[0]!))?.claimedAt).toBe(200);
  db.close();
});

/**
 * @case independent review probe 11
 * @preconditions An authorized route expires under its restored stored principal
 * @expectedResult Entry refusal prevents notification but sweep still finalizes expiry
 */
test("review: protected expiry is finalized without reaching error notification", async () => {
  let nags = 0;
  const observer = infrastructure({
    id: "audit",
    bind(c) {
      c.contribute({
        kind: "handler",
        id: "nag",
        point: "error",
        survival: allRuns,
        handle(ex) {
          nags++;
          return { kind: "allow", exchange: ex };
        },
      });
    },
  });
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    auth,
    observer,
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
  expect(await app.runtime.sweep()).toBe(1);
  expect(nags).toBe(0);
  expect((await app.host.service(CONTINUATIONS).get(id))?.state).toBe(
    "expired",
  );
  await app.stop();
});

const CUSTOM: unique symbol = Symbol("review read-only");
void CUSTOM;
declare module "../../src/v2/contracts.ts" {
  interface HandlerPoints {
    "review:read": { readonly owner: typeof CUSTOM; readonly refuse: false };
  }
}
/**
 * @case independent review probe 12
 * @preconditions A JavaScript-style handler refuses at a custom no-refusal point
 * @expectedResult Invocation returns null without the required fault
 */
test("review: custom no-refusal point is not enforced at runtime", async () => {
  let result: Exchange | null | undefined;
  const plugin = infrastructure({
    id: "review",
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
        result = await ctx.invoke("review:read", ex);
        return { kind: "continue", exchange: ex };
      })
      .build(),
  ]);
  expect((await app.runtime.deliver("r", 0)).status).toBe("completed");
  expect(result).toBeNull();
  await app.stop();
});

/**
 * @case independent review probe 13
 * @preconditions Two exit handlers decorate and observe a replacement envelope
 * @expectedResult The next handler sees the decoration but the caller does not
 */
test("review: exit decoration is seen by next handler but missing from returned result", async () => {
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
  expect(result.exchanges[0]?.body).toBe("original");
  await app.stop();
});

/**
 * @case independent review probe 14
 * @preconditions A second deployment appends an audit instruction to the live tail
 * @expectedResult The old approval resumes without invalidation and skips the audit
 */
test("review: appended tail step is absent from hash and silently skipped on resume", async () => {
  const make = async (append: boolean) => {
    const app = application([operations, deferral, sqlite(":memory:")]);
    const spec = app.route("r").from(manual).defer("a").build();
    const steps = [
      ...spec.steps,
      instruction("routecraft.operations", "pay", (ex) => ({
        kind: "continue",
        exchange: { ...ex, body: "pay" },
      })),
    ];
    if (append)
      steps.push(
        instruction("routecraft.operations", "audit", (ex) => ({
          kind: "continue",
          exchange: { ...ex, body: "audit" },
        })),
      );
    await app.start([{ ...spec, steps }]);
    return app;
  };
  const a = await make(false),
    b = await make(true);
  const id = (await a.runtime.deliver("r", 0)).deferrals[0]!;
  await b.host
    .service(CONTINUATIONS)
    .create(id, (await a.host.service(CONTINUATIONS).get(id))!.continuation);
  expect((await b.runtime.resume(id)).exchanges[0]?.body).toBe("pay");
  await a.stop();
  await b.stop();
});

/**
 * @case independent review probe 15
 * @preconditions A prefix instruction is added before an unchanged tail callable
 * @expectedResult The generated tail instruction id shifts and resume refuses
 */
test("review: adding prefix transform changes tail identity despite same tail callable", async () => {
  const suffix = (n: unknown) => Number(n) * 2;
  const make = async (prefix: boolean) => {
    const app = application([operations, deferral, sqlite(":memory:")]);
    let chain = app.route("r").from(manual);
    if (prefix) chain = chain.transform((x) => x);
    await app.start([chain.defer("a").transform(suffix).build()]);
    return app;
  };
  const a = await make(false),
    b = await make(true);
  const id = (await a.runtime.deliver("r", 2)).deferrals[0]!;
  await b.host
    .service(CONTINUATIONS)
    .create(id, (await a.host.service(CONTINUATIONS).get(id))!.continuation);
  await expect(b.runtime.resume(id)).rejects.toThrow("PLAN_MISMATCH");
  await a.stop();
  await b.stop();
});

/**
 * @case independent review probe 16
 * @preconditions A replacement store exposes a scan spy and has resumed residue
 * @expectedResult Startup never calls the scan although the record remains discoverable
 */
test("review: startup never scans resumed-without-outcome residue", async () => {
  let scans = 0;
  const db = new SqliteRecords(":memory:"),
    store = durableStore(db);
  await store.create("e#1", saved());
  await store.markResumed("e#1", 2);
  const provider = infrastructure({
    id: "review",
    provides: [CONTINUATIONS],
    bind(c) {
      c.provide(CONTINUATIONS, {
        ...store,
        resumedWithoutOutcome: async () => {
          scans++;
          return store.resumedWithoutOutcome();
        },
      });
    },
  });
  const app = application([operations, provider]);
  await app.start([]);
  expect(scans).toBe(0);
  expect(await store.resumedWithoutOutcome()).toEqual(["e#1"]);
  await app.stop();
  db.close();
});

/**
 * @case independent review probe 17
 * @preconditions An overdue orphan precedes work for a present route
 * @expectedResult Sweep claims the orphan then aborts without reaching valid work
 */
test("review: orphan ahead of due work aborts sweep after claiming it", async () => {
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([app.route("r").from(manual).defer("a", -1).build()]);
  const store = app.host.service(CONTINUATIONS);
  await store.create("orphan", saved(0, "removed-route"));
  const id = (await app.runtime.deliver("r", 0)).deferrals[0]!;
  await expect(app.runtime.sweep()).rejects.toThrow("UNKNOWN_ROUTE");
  expect((await store.get("orphan"))?.claimedAt).toBeDefined();
  expect((await store.get(id))?.state).toBe("waiting");
  await app.stop();
});

/**
 * @case independent review probe 18
 * @preconditions A built authorized route moves to an application with only an authority provider
 * @expectedResult The required port is present but the body executes without authorization
 */
test("review: a valid authority provider without the old handler satisfies the route requirement but fails open", async () => {
  const author = application([operations, auth]);
  const spec = author
    .route("r")
    .authorize("pay")
    .from(manual)
    .transform(() => "paid")
    .build();
  const provider = infrastructure({
    id: "vendor.jwt",
    namespace: "auth",
    provides: [AUTHORITY],
    bind(c) {
      c.provide(AUTHORITY, {
        principalOf: () => undefined,
        effective: () => [],
      });
    },
  });
  const runtime = application([operations, provider]);
  await runtime.start([spec]);
  expect((await runtime.runtime.deliver("r", 0)).exchanges[0]?.body).toBe(
    "paid",
  );
  await runtime.stop();
});
