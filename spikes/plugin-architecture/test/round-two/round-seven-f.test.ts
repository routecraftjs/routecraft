import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  application,
  infrastructure,
  instruction,
  continueWith,
  operations,
  deferral,
  deferralPlugin,
  sqlite,
  auth,
  principals,
  manual,
  withPrincipal,
  encode,
  decode,
  markSecret,
  allRuns,
  CONTINUATIONS,
  DEFERRAL_RESUMED_AT,
  DEFERRAL_RESUMED_BY,
  DEFAULT_TTL,
  SqliteRecords,
  durableStore,
  type Continuation,
  type ContinuationStore,
  type Fault,
  type Step,
  type StepOutcome,
} from "../../src/v2/index.ts";

/**
 * Round 7f: the clean-room review of round 7e (`reviews/FABLE-ROUND-7E.md`)
 * inverted, and the resume door as `#818` shipped it.
 *
 * Its eighteen probes asserted what the head did; here each asserts what it
 * must do, by the finding's number. The door tests record ruling 12 as
 * amended (the continuation runs as the parked identity; the door's
 * `elevate` may lend within the recorded refusal) and ruling 13 (the default
 * door policy is the route's own grants). The last group gives the review's
 * surviving mutants a test each.
 */

const temp = (name: string) => mkdtempSync(join(tmpdir(), `rc-7f-${name}-`));
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
const nags = (seen: string[], id = "acme.ops") =>
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
const gated = () =>
  application([operations, deferral, sqlite(":memory:"), principals, auth]);
const alice = (lent: string[] = []) =>
  withPrincipal({}, { subject: "alice", grants: [], lent });
const bob = withPrincipal(
  {},
  { subject: "bob", grants: ["approve"], lent: [] },
);

/**
 * @case F1: an ask with no grants still asks
 * @preconditions a route with a bare `.authorize()`, delivered anonymously and with an authentic principal
 * @expectedResult the anonymous delivery is refused; the authentic one runs */
test("F1: .authorize() with no grants demands an authentic principal", async () => {
  const app = application([operations, principals, auth]);
  await app.start([
    app
      .route("r")
      .authorize()
      .from(manual)
      .transform(() => "ran")
      .build(),
  ]);
  expect((await app.runtime.deliver("r", 0)).status).toBe("refused");
  expect((await app.runtime.deliver("r", 0, alice())).exchanges[0]?.body).toBe(
    "ran",
  );
  await app.stop();
});

/**
 * @case F2 and F3: the record keeps a reference, never the ingress
 * @preconditions bob resumes with a secret beside his principal; the continuation fails
 * @expectedResult the record's resumer is a subject reference written by the swap, the secret reaches neither record nor continuation, and a secret that tries to park is refused by name */
test("F2, F3: who resumed is on the record from the swap, as a reference, even when the continuation fails", async () => {
  const app = gated();
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("a")
      .transform((_, ex) => {
        if (ex.headers["token"] !== undefined) throw Error("ingress leaked");
        throw Error("payment failed");
      })
      .build(),
    app.route("leaky").from(manual).defer("a").build(),
  ]);
  const id = (await app.runtime.deliver("r", 0, alice())).deferrals[0]!;
  const store = app.host.service(CONTINUATIONS);
  await expect(
    app.runtime.resume(id, {
      headers: { ...bob, token: markSecret({ bearer: "s3cret" }) },
    }),
  ).rejects.toThrow("payment failed");
  const record = (await store.get(id))!;
  expect(record.by).toEqual({ auth: { resumedBy: { subject: "bob" } } });
  expect(record.outcome?.status).toBe("failed");
  expect(JSON.stringify(record)).not.toContain("s3cret");
  await expect(
    app.runtime.deliver("leaky", 0, { token: markSecret({ bearer: "x" }) }),
  ).rejects.toThrow("NOT_PERSISTABLE: headers.token holds a secret");
  await app.stop();
});

/**
 * @case F4 and F5: the door sees a view, and judges before the route is resolved
 * @preconditions an admission handler ordered ahead of the gate; a record for a route this application lacks
 * @expectedResult the handler is handed the parked headers and no body; a refused caller of the orphan learns nothing, an admitted one learns UNKNOWN_ROUTE */
test("F4, F5: the door gets no body, and an unknown route is disclosed only past the door", async () => {
  const seen: unknown[] = [];
  let allow = false;
  const audit = infrastructure({
    id: "acme.audit",
    bind: (c) =>
      c.contribute({
        kind: "handler",
        id: "log",
        point: "admission",
        survival: allRuns,
        handle(ex, { kind, resume }) {
          if (kind === "resume")
            seen.push({
              body: ex.body,
              keys: Object.keys(resume ?? {}).sort(),
            });
          return allow
            ? { kind: "allow", exchange: ex }
            : { kind: "refuse", reason: "closed" };
        },
      }),
  });
  const app = application([operations, deferral, sqlite(":memory:"), audit]);
  await app.start([app.route("r").from(manual).defer("a").build()]);
  const store = app.host.service(CONTINUATIONS);
  await store.create("orphan#1", parked(undefined, "removed-route"));
  expect((await app.runtime.resume("orphan#1", { payload: "p" })).status).toBe(
    "refused",
  );
  expect(seen).toEqual([
    {
      body: "p",
      keys: ["headers", "id", "parkedAt", "payload", "routeId", "site"],
    },
  ]);
  allow = true;
  await expect(app.runtime.resume("orphan#1")).rejects.toThrow("UNKNOWN_ROUTE");
  await app.stop();
});

/** A continuation store whose swap is slow, standing in for a door that awaited. */
function slowStore(delay: number) {
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
 * @case F6: the deadline is checked again after the swap
 * @preconditions a record due in 30 ms and a swap that takes 80 ms
 * @expectedResult the resume wins the swap and is then refused as expired: the suffix does not run, the failure is recorded, the route is told once */
test("F6: a resume that crosses the deadline while at the door does not run", async () => {
  const seen: string[] = [];
  let ran = 0;
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    slowStore(80),
    nags(seen),
  ]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("a", 30)
      .transform(() => ++ran)
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", 0)).deferrals[0]!;
  await expect(app.runtime.resume(id)).rejects.toThrow(
    "expired while at the door",
  );
  expect(ran).toBe(0);
  expect(seen).toHaveLength(1);
  const record = (await app.host.service(CONTINUATIONS).get(id))!;
  expect(record.state).toBe("resumed");
  expect(record.outcome?.status).toBe("failed");
  expect((await app.runtime.resume(id)).outcome?.status).toBe("failed");
  await app.stop();
});

/**
 * @case F7: a nested path may not park
 * @preconditions a step running a child path in which a step defers
 * @expectedResult the path fails with DEFER_IN_PATH before anything is written; the parent decides; no record waits */
test("F7: a defer inside runPath is refused, never parked", async () => {
  const app = application([operations, deferral, sqlite(":memory:")]);
  const child = instruction("routecraft.operations", "child", (ex) => ({
    kind: "defer",
    exchange: ex,
    request: { name: "nested", reason: "x" },
  }));
  await app.start([
    app
      .route("r")
      .from(manual)
      .step(
        "parent",
        async (ex, ctx) => {
          const result = await ctx.runPath({ steps: [child], exchange: ex });
          return {
            kind: "continue",
            exchange: {
              ...ex,
              body: `${result.failed}:${result.error?.message}`,
            },
          };
        },
        [child],
      )
      .build(),
  ]);
  const result = await app.runtime.deliver("r", 0);
  expect(result.status).toBe("completed");
  expect(result.exchanges[0]?.body).toContain("true:");
  expect(result.exchanges[0]?.body).toContain("DEFER_IN_PATH");
  expect(await app.host.service(CONTINUATIONS).pending()).toEqual({ count: 0 });
  await app.stop();
});

/** A route whose branching step chooses among three declared children by the body. */
function chooser(tailBody: string) {
  const app = application([operations, deferral, sqlite(":memory:")]);
  // The body is declared source, not a captured variable, so editing it moves the hash.
  const leaf = (id: string, body: string): Step => ({
    ...instruction("routecraft.operations", id, (ex) => ({
      kind: "continue",
      exchange: { ...ex, body: `${String(ex.body)}+${body}` },
    })),
    source: [body],
  });
  const park = (id: string): Step =>
    instruction("routecraft.operations", id, (ex, ctx): StepOutcome =>
      ctx.kind === "resume"
        ? continueWith(ex)
        : {
            kind: "defer",
            exchange: ex,
            request: { name: id, reason: "x", reenter: true },
          },
    );
  const x = park("x"),
    y = leaf("y", "y"),
    z = leaf("z", "z");
  const branch = instruction(
    "routecraft.operations",
    "branch",
    (ex) => ({
      kind: "branch",
      exchange: ex,
      steps:
        ex.body === "middle" ? [y, x] : ex.body === "reversed" ? [z, x] : [x],
    }),
    [x, y, z],
  );
  const tail = leaf("tail", tailBody);
  const spec = app.route("r").from(manual).build();
  return { app, spec: { ...spec, steps: [...spec.steps, branch, tail] } };
}

/**
 * @case F8: a branch may choose any of its declared children, in any order
 * @preconditions a branch returning a middle child, a reversed pair, and a single child, each parking inside the choice; then deployments that edit the chosen path, the unchosen sibling, and the tail
 * @expectedResult every shape parks and resumes along the chosen path; an edit to an unchosen sibling does not invalidate the approval, an edit to the tail after the choice does */
test("F8: frames address the chosen children, bounded, and the tail as a suffix", async () => {
  const origin = chooser("tail");
  await origin.app.start([origin.spec]);
  const store = origin.app.host.service(CONTINUATIONS);
  const ids: Record<string, string> = {};
  for (const body of ["middle", "reversed", "single"])
    ids[body] = (await origin.app.runtime.deliver("r", body)).deferrals[0]!;
  expect((await store.get(ids["middle"]!))!.continuation.frames).toEqual([
    { list: "branch", from: 0, to: 1 },
    { list: null, from: 1 },
  ]);
  expect(
    (await origin.app.runtime.resume(ids["middle"]!)).exchanges[0]?.body,
  ).toBe("middle+y+tail");
  expect(
    (await origin.app.runtime.resume(ids["reversed"]!)).exchanges[0]?.body,
  ).toBe("reversed+z+tail");
  expect(
    (await origin.app.runtime.resume(ids["single"]!)).exchanges[0]?.body,
  ).toBe("single+tail");
  // A sibling the branch did not choose is not in the approval; the tail after the choice is.
  const middle = (await origin.app.runtime.deliver("r", "middle"))
    .deferrals[0]!;
  const record = (await store.get(middle))!.continuation;
  const edited = chooser("audited");
  await edited.app.start([edited.spec]);
  await edited.app.host.service(CONTINUATIONS).create(middle, record);
  await expect(edited.app.runtime.resume(middle)).rejects.toThrow(
    "PLAN_MISMATCH",
  );
  await Promise.all([origin.app.stop(), edited.app.stop()]);
});

/**
 * @case F9 and F10: the shipped persistence rules, one by one
 * @preconditions values exercising each rule of the codec
 * @expectedResult each non-plain value is refused by path and name, `__proto__` survives as data both ways, and a corrupt envelope is refused on the way back */
test("F9, F10: the codec refuses what shipped refuses and revives what shipped revives", () => {
  const owner = "t";
  const refuses = (value: unknown, what: string) =>
    expect(() => encode(value, owner)).toThrow(
      `NOT_PERSISTABLE: value holds ${what}`,
    );
  refuses(markSecret({ bearer: "x" }), "a secret");
  refuses({ [Symbol("k")]: 1 }, "a symbol-keyed property");
  refuses(
    Object.defineProperty({}, "hidden", { value: 1, enumerable: false }),
    "a non-enumerable property (hidden)",
  );
  refuses(
    Object.assign([1], { named: true }),
    "a named array property (named)",
  );
  class Stamp extends Date {}
  refuses(new Stamp(0), "a Date subclass");
  refuses(
    Object.assign(new Date(0), { extra: 1 }),
    "a Date carrying extra properties",
  );
  refuses({ $date: "2026-01-01T00:00:00.000Z" }, "the reserved date envelope");
  refuses(Number.NaN, "a non-finite number");
  refuses(Symbol("s"), "a symbol");
  refuses(1n, "a bigint");
  refuses(() => 1, "a function");
  const loop: Record<string, unknown> = {};
  loop["self"] = loop;
  expect(() => encode(loop, owner)).toThrow("value.self holds a cycle");
  expect(() => encode({ a: { b: new Map() } }, owner)).toThrow(
    "value.a.b holds an instance of Map",
  );
  const proto = JSON.parse('{"__proto__": {"admin": true}, "x": 1}') as object;
  const encoded = encode(proto, owner) as Record<string, unknown>;
  expect(Object.getOwnPropertyNames(encoded).sort()).toEqual([
    "__proto__",
    "x",
  ]);
  const decoded = decode(JSON.parse(JSON.stringify(encoded))) as Record<
    string,
    unknown
  >;
  expect(Object.getOwnPropertyNames(decoded)).toContain("__proto__");
  expect(Object.getPrototypeOf(decoded)).toBeNull();
  expect(() => decode({ when: { $date: "not a date" } })).toThrow(
    "CORRUPT_ENVELOPE: value.when holds a date envelope that is not a date",
  );
  expect(decode({ $date: "2026-01-01T00:00:00.000Z" })).toBeInstanceOf(Date);
});

/**
 * @case F11: the boot report reads the selected store
 * @preconditions a vendor continuation store replacing the default, holding a stranded record and a waiting one
 * @expectedResult the deferral plugin's boot event reports the vendor's records */
test("F11: with a vendor store selected, the boot scan reports that store", async () => {
  const db = new SqliteRecords(":memory:"),
    vendor = durableStore(db);
  await vendor.create("stranded#1", parked(undefined));
  await vendor.markResumed("stranded#1", Date.now());
  await vendor.create("waiting#1", parked(undefined, "r", 7));
  const events: { name: string; data: unknown }[] = [];
  const app = application([
    operations,
    deferralPlugin({ interval: 0 }),
    sqlite(":memory:"),
    infrastructure({
      id: "vendor.store",
      provides: [CONTINUATIONS],
      replaces: [CONTINUATIONS],
      bind: (c) => {
        c.provide(CONTINUATIONS, vendor);
        c.onDispose(() => db.close());
      },
    }),
    infrastructure({
      id: "acme.log",
      bind: (c) => c.observe((e) => events.push(e)),
    }),
  ]);
  await app.start([app.route("r").from(manual).defer("a").build()]);
  expect(events.find((e) => e.name === "deferral:boot")?.data).toMatchObject({
    stranded: ["stranded#1"],
    pending: { count: 1, oldest: 7 },
  });
  await app.stop();
});

/**
 * @case F12: a stop during a sweep finishes the record it claimed
 * @preconditions a sweep delivering a nag whose handler is still running when stop begins
 * @expectedResult the nag completes, the record is expired, and stop returns without abandoning work */
test("F12: a sweep in flight when stop begins delivers what it claimed", async () => {
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
          seen.push("started");
          await gate;
          seen.push("delivered");
          return { kind: "allow", exchange: ex };
        },
      }),
  });
  const app = application([operations, deferral, sqlite(":memory:"), slowNag]);
  await app.start([app.route("r").from(manual).defer("a", -1).build()]);
  await app.runtime.deliver("r", 0);
  const sweep = app.runtime.sweep();
  while (!seen.length) await new Promise((r) => setTimeout(r, 5));
  const stopping = app.stop();
  await new Promise((r) => setTimeout(r, 20));
  release();
  await stopping;
  // Retired means the claim, the delivery and the settle all completed under the stop.
  expect((await sweep).retired).toBe(1);
  expect(seen).toEqual(["started", "delivered"]);
});

/**
 * @case F14: a park has a deadline unless the context opts out
 * @preconditions `.defer("a")` with no ttl under the default plugin, and under one configured with `ttl: null`
 * @expectedResult the first comes due in 72 hours, the second never */
test("F14: the deferral plugin applies a default ttl, and null opts out", async () => {
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([app.route("r").from(manual).defer("a").build()]);
  const before = Date.now();
  const id = (await app.runtime.deliver("r", 0)).deferrals[0]!;
  const expiresAt = (await app.host.service(CONTINUATIONS).get(id))!
    .continuation.expiresAt!;
  expect(expiresAt - before).toBeGreaterThanOrEqual(DEFAULT_TTL);
  expect(expiresAt - before).toBeLessThan(DEFAULT_TTL + 1000);
  await app.stop();
  const forever = application([
    operations,
    deferralPlugin({ ttl: null, interval: 0 }),
    sqlite(":memory:"),
  ]);
  await forever.start([forever.route("r").from(manual).defer("a").build()]);
  const never = (await forever.runtime.deliver("r", 0)).deferrals[0]!;
  expect(
    (await forever.host.service(CONTINUATIONS).get(never))!.continuation
      .expiresAt,
  ).toBeUndefined();
  await forever.stop();
});

/**
 * @case ruling 13: the door's default policy, and a declared one
 * @preconditions a route gated on a grant parked under alice; resumes by bob who holds it, by carol who does not, and then the same route with a declared `authorize` hook admitting carol alone
 * @expectedResult without a hook the route's grants are asked of the resumer; with one, the hook is the whole policy and sees both principals */
test("ruling 13: the route's grants are the default door policy, and .resumable({ authorize }) replaces it", async () => {
  const app = gated();
  const inputs: string[] = [];
  await app.start([
    app
      .route("plain")
      .authorize("approve")
      .from(manual)
      .defer("a")
      .transform(() => "ran")
      .build(),
    app
      .route("hooked")
      .authorize("approve")
      .resumable({
        authorize: ({ principal, deferred }) => {
          inputs.push(
            `${principal?.subject}:${principal?.authentic}/${deferred?.subject}:${deferred?.authentic}`,
          );
          return principal?.subject === "carol";
        },
      })
      .from(manual)
      .defer("a")
      .transform(() => "ran")
      .build(),
  ]);
  const carol = withPrincipal({}, { subject: "carol", grants: [], lent: [] });
  const requester = withPrincipal(
    {},
    { subject: "alice", grants: ["approve"], lent: [] },
  );
  const plain = (await app.runtime.deliver("plain", 0, requester))
    .deferrals[0]!;
  expect((await app.runtime.resume(plain, { headers: carol })).status).toBe(
    "refused",
  );
  expect(
    (await app.runtime.resume(plain, { headers: bob })).exchanges[0]?.body,
  ).toBe("ran");
  const hooked = (await app.runtime.deliver("hooked", 0, requester))
    .deferrals[0]!;
  expect((await app.runtime.resume(hooked, { headers: bob })).status).toBe(
    "refused",
  );
  expect(
    (await app.runtime.resume(hooked, { headers: carol })).exchanges[0]?.body,
  ).toBe("ran");
  expect(inputs).toEqual(["bob:true/alice:false", "carol:true/alice:false"]);
  await app.stop();
});

/** The step-up plugin: a refusal at admission parks the whole route, with the refused grants as the record's bound. */
const stepUp = (notified: string[]) =>
  infrastructure({
    id: "acme.stepup",
    requires: [CONTINUATIONS],
    bind: (c) => {
      c.observe((e) => {
        if (e.name === "exchange:deferred")
          notified.push(`event:${(e.data as { id: string }).id}`);
      });
      c.contribute({
        kind: "handler",
        id: "park-refusals",
        point: "error",
        survival: allRuns,
        mayDefer: true,
        handle: (ex, { error, kind }) =>
          error?.code === "REFUSED" && kind === "normal"
            ? {
                kind: "defer",
                request: {
                  name: "step-up",
                  reason: "refused",
                  notify: async (id) => {
                    // Told only once the record is durable, and before the event.
                    if (!(await c.require(CONTINUATIONS).get(id)))
                      throw Error("not durable");
                    notified.push(`notified:${id}`);
                  },
                },
              }
            : { kind: "allow", exchange: ex },
      });
    },
  });

/**
 * @case the step-up flow, end to end
 * @preconditions a payout route gated on a grant alice lacks; a step-up plugin parking refusals; a door that lets a manager lend exactly the refused grant
 * @expectedResult the refusal parks the whole route with the refused grants recorded; the manager's resume re-mints alice with the grant lent, the route's own gate passes, the payout runs as alice with the manager recorded; a lend wider than the refusal, a lend that changes identity, and a stale re-mint are each refused before the approval is spent */
test("step-up: refused, parked from the error ring, lent at the door, run as the requester", async () => {
  const notified: string[] = [];
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    principals,
    auth,
    stepUp(notified),
  ]);
  const manager = withPrincipal(
    {},
    { subject: "manager", grants: ["lend"], lent: [] },
  );
  const lend =
    (lent: string[], subject = "alice") =>
    ({
      deferred,
    }: {
      deferred?: { subject: string; grants: readonly string[] };
    }) =>
      withPrincipal(
        {},
        {
          subject: subject === "alice" ? deferred!.subject : subject,
          grants: [...deferred!.grants],
          lent,
        },
      );
  const route = (
    id: string,
    elevate: ReturnType<typeof lend> | ((i: never) => Record<string, unknown>),
  ) =>
    app
      .route(id)
      .authorize("payout:write")
      .resumable({
        authorize: ({ principal }) => principal?.subject === "manager",
        elevate: elevate as never,
      })
      .from(manual)
      .transform(
        (_, ex) =>
          `${ex.auth.principal?.subject}:${ex.auth.principal?.authentic}:${[...(ex.auth.principal?.lent ?? [])].join()}:${ex.auth.resumedBy?.subject}`,
      )
      .build();
  await app.start([
    route("payout", lend(["payout:write"])),
    route("greedy", lend(["payout:write", "admin"])),
    route("swap", lend(["payout:write"], "mallory")),
    route("stale", () => ({
      "routecraft.principal": {
        subject: "alice",
        grants: [],
        lent: ["payout:write"],
      },
    })),
  ]);
  const store = app.host.service(CONTINUATIONS);
  const park = async (id: string) => {
    const result = await app.runtime.deliver(id, 0, alice());
    expect(result.status).toBe("deferred");
    return result.deferrals[0]!;
  };
  const payout = await park("payout");
  expect(notified).toEqual([`notified:${payout}`, `event:${payout}`]);
  const record = (await store.get(payout))!.continuation;
  expect(record).toMatchObject({
    site: null,
    frames: [{ list: null, from: 0 }],
    refusal: { refused: ["payout:write"] },
  });
  expect((await app.runtime.resume(payout, { headers: bob })).status).toBe(
    "refused",
  );
  expect((await store.get(payout))?.state).toBe("waiting");
  expect(
    (await app.runtime.resume(payout, { headers: manager })).exchanges[0]?.body,
  ).toBe("alice:true:payout:write:manager");
  for (const id of ["greedy", "swap", "stale"]) {
    const parkedId = await park(id);
    expect(
      (await app.runtime.resume(parkedId, { headers: manager })).status,
    ).toBe("refused");
    expect((await store.get(parkedId))?.state).toBe("waiting");
  }
  await app.stop();
});

/**
 * @case a failure inside a step parks at that step
 * @preconditions a step that throws once, an error handler that parks failures
 * @expectedResult the park re-enters the failing step, the prefix does not run again, and the resumed run completes; a handler that parks without declaring it is a named fault */
test("error-path park: a failing step is re-entered on resume, and an undeclared park is refused", async () => {
  const log: string[] = [];
  let failures = 1;
  const parker = (mayDefer: boolean) =>
    infrastructure({
      id: "acme.parker",
      bind: (c) =>
        c.contribute({
          kind: "handler",
          id: "park",
          point: "error",
          survival: allRuns,
          ...(mayDefer ? { mayDefer } : {}),
          handle: (_, { kind }) =>
            kind === "normal"
              ? {
                  kind: "defer",
                  request: { name: "retry-later", reason: "failed" },
                }
              : { kind: "allow", exchange: _ },
        }),
    });
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    parker(true),
  ]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .transform((x) => {
        log.push("prefix");
        return x;
      })
      .transform((x) => {
        if (failures-- > 0) throw Error("flaky");
        log.push("suffix");
        return x;
      })
      .build(),
  ]);
  const parked = await app.runtime.deliver("r", 1);
  expect(parked.status).toBe("deferred");
  const record = (await app.host
    .service(CONTINUATIONS)
    .get(parked.deferrals[0]!))!.continuation;
  expect(record.site).toBe("routecraft.operations:transform:1");
  expect(record.frames).toEqual([{ list: null, from: 1 }]);
  expect(
    (await app.runtime.resume(parked.deferrals[0]!)).exchanges[0]?.body,
  ).toBe(1);
  expect(log).toEqual(["prefix", "suffix"]);
  await app.stop();
  const undeclared = application([
    operations,
    deferral,
    sqlite(":memory:"),
    parker(false),
  ]);
  await undeclared.start([
    undeclared
      .route("r")
      .from(manual)
      .transform(() => {
        throw Error("boom");
      })
      .build(),
  ]);
  try {
    await undeclared.runtime.deliver("r", 1);
    throw Error("did not fail");
  } catch (e) {
    const f = e as Fault;
    expect(f.message).toContain("boom");
    expect(f.secondary.map((x) => x.code)).toEqual(["DEFER_UNDECLARED"]);
  }
  await undeclared.stop();
});

/**
 * @case the review's surviving mutants: the sweep as wired
 * @preconditions 150 due records; 105 orphans ahead of one live record with pages of ten; a settled record past retention; a claim younger than the lease and one older
 * @expectedResult two pages retire all 150; the orphans are counted and the live record retired without looping; the sweep purges; the sweep releases only the old claim */
test("sweep as wired: pages past the first, past orphans, purges, and heals by the lease", async () => {
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([app.route("r").from(manual).defer("a", -1).build()]);
  const store = app.host.service(CONTINUATIONS);
  for (let i = 0; i < 150; i++) await store.create(`due#${i}`, parked(i));
  expect(await app.runtime.sweep({ now: 1000 })).toMatchObject({
    visited: 150,
    retired: 150,
  });
  for (let i = 0; i < 105; i++)
    await store.create(`orphan#${i}`, parked(i, "gone"));
  const live = (await app.runtime.deliver("r", 0)).deferrals[0]!;
  const report = await app.runtime.sweep({ pageSize: 10 });
  expect(report).toMatchObject({ retired: 1, orphans: { gone: 105 } });
  expect((await store.get(live))?.state).toBe("expired");
  expect((await app.runtime.sweep({ retention: 1, pageSize: 10 })).purged).toBe(
    151,
  );
  await store.create("claimed#1", parked(Date.now() + 1_000_000));
  await store.claimExpiry("claimed#1", Date.now() - 50);
  expect((await app.runtime.sweep({ lease: 1000 })).released).toBe(0);
  expect((await app.runtime.sweep({ lease: 10 })).released).toBe(1);
  await app.stop();
});

/**
 * @case the review's surviving mutants: the resume path's untested branches
 * @preconditions a record whose expiry claim is lost to a resume that won; a claimed record; a lent grant; a duplicate route id; the resumedAt header; 101 stranded records
 * @expectedResult the losing settle answers duplicate; the claimed record is RESUME_SETTLED; the lent grant admits; the duplicate id refuses to compile; the header is a number; the boot report is bounded at one hundred */
test("resume path branches: settle after a winning resume, claimed records, lent grants, duplicate routes, resumedAt, the stranded bound", async () => {
  const db = new SqliteRecords(":memory:"),
    inner = durableStore(db);
  let reads = 0;
  const racing: ContinuationStore = {
    ...inner,
    async get(id) {
      const record = await inner.get(id);
      // The first read sees waiting; by the time the settle re-reads, a concurrent resume has won.
      if (record && id === "raced#1" && reads++ === 1)
        await inner.markResumed(id, 5);
      return reads > 1 && id === "raced#1" ? inner.get(id) : record;
    },
    claimExpiry: async () => "lost",
  };
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    principals,
    auth,
    infrastructure({
      id: "acme.racing",
      provides: [CONTINUATIONS],
      replaces: [CONTINUATIONS],
      bind: (c) => {
        c.provide(CONTINUATIONS, racing);
        c.onDispose(() => db.close());
      },
    }),
  ]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("a", -1)
      .transform((_, ex) => ex.headers[DEFERRAL_RESUMED_AT])
      .build(),
    app
      .route("sink")
      .authorize("approve")
      .from(manual)
      .transform(() => "ok")
      .build(),
    app
      .route("later")
      .from(manual)
      .defer("a")
      .transform((_, ex) => ex.headers[DEFERRAL_RESUMED_AT])
      .build(),
  ]);
  await racing.create("raced#1", { ...parked(1), routeId: "r" });
  expect((await app.runtime.resume("raced#1")).status).toBe("duplicate");
  const later = (await app.runtime.deliver("later", 0)).deferrals[0]!;
  await inner.create("claimed#1", (await inner.get(later))!.continuation);
  await inner.claimExpiry("claimed#1", 1);
  await expect(app.runtime.resume("claimed#1")).rejects.toThrow(
    "RESUME_SETTLED: claimed#1: claimed",
  );
  expect(typeof (await app.runtime.resume(later)).exchanges[0]?.body).toBe(
    "number",
  );
  expect(
    (await app.runtime.deliver("sink", 0, alice(["approve"]))).exchanges[0]
      ?.body,
  ).toBe("ok");
  expect((await app.runtime.deliver("sink", 0, alice())).status).toBe(
    "refused",
  );
  await app.stop();
  const twice = application([operations]);
  await expect(
    twice.start([
      twice.route("r").from(manual).build(),
      twice.route("r").from(manual).build(),
    ]),
  ).rejects.toThrow("DUPLICATE_ROUTE");
  const dir = temp("bound");
  try {
    const many = new SqliteRecords(join(dir, "d.db")),
      stranded = durableStore(many);
    for (let i = 0; i < 101; i++) {
      await stranded.create(`s#${i}`, parked(undefined));
      await stranded.markResumed(`s#${i}`, Date.now());
    }
    many.close();
    const events: { name: string; data: unknown }[] = [];
    const boot = application([
      operations,
      deferralPlugin({ interval: 0 }),
      sqlite(join(dir, "d.db")),
      infrastructure({
        id: "acme.log",
        bind: (c) => c.observe((e) => events.push(e)),
      }),
    ]);
    await boot.start([]);
    expect(
      (
        events.find((e) => e.name === "deferral:boot")?.data as {
          stranded: string[];
        }
      ).stranded,
    ).toHaveLength(100);
    await boot.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * @case what a resumed continuation carries, exactly
 * @preconditions bob resumes with a payload and an extra header
 * @expectedResult the continuation's headers are the parked ones plus the record id, the payload, the time and the door's record; nothing else from the ingress */
test("a resumed continuation carries the parked headers plus four of the kernel's, and nothing from the ingress", async () => {
  const app = gated();
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("a")
      .transform((_, ex) => Object.keys(ex.headers).sort())
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", 0, { ...alice(), mine: 1 }))
    .deferrals[0]!;
  const keys = (
    await app.runtime.resume(id, {
      payload: "p",
      headers: { ...bob, via: "slack" },
    })
  ).exchanges[0]?.body;
  expect(keys).toEqual([
    "mine",
    "routecraft.deferral.id",
    "routecraft.deferral.result",
    "routecraft.deferral.resumedAt",
    "routecraft.deferral.resumedBy",
    "routecraft.deferral.sequence",
    "routecraft.principal",
  ]);
  const record = (await app.host.service(CONTINUATIONS).get(id))!;
  expect(
    (record.outcome?.exchanges[0]?.headers as Record<string, unknown>)[
      DEFERRAL_RESUMED_BY
    ],
  ).toEqual({
    auth: { resumedBy: { subject: "bob" } },
  });
  await app.stop();
});

/** A continuation store wrapper for the sweep tests: a slow claim, or a scan that ignores its cursor. */
function wrappedStore(
  patch: (inner: ContinuationStore) => Partial<ContinuationStore>,
) {
  const db = new SqliteRecords(":memory:"),
    inner = durableStore(db);
  return infrastructure({
    id: "acme.wrapped",
    provides: [CONTINUATIONS],
    replaces: [CONTINUATIONS],
    bind: (c) => {
      c.provide(CONTINUATIONS, { ...inner, ...patch(inner) });
      c.onDispose(() => db.close());
    },
  });
}

/**
 * @case F12, the other window: a stop between the claim and the delivery
 * @preconditions a store whose claim takes 50 ms; a stop that begins while the sweep is inside that claim
 * @expectedResult the claimed record is still delivered and retired during the drain, so it is not left claimed for the lease to heal */
test("F12: a record claimed as the stop began is still delivered during the drain", async () => {
  const seen: string[] = [];
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    wrappedStore((inner) => ({
      claimExpiry: async (id, at) => {
        await new Promise((r) => setTimeout(r, 50));
        return inner.claimExpiry(id, at);
      },
    })),
    nags(seen),
  ]);
  await app.start([app.route("r").from(manual).defer("a", -1).build()]);
  await app.runtime.deliver("r", 0);
  const sweep = app.runtime.sweep();
  await new Promise((r) => setTimeout(r, 10));
  const stopping = app.stop();
  expect((await sweep).retired).toBe(1);
  expect(seen).toHaveLength(1);
  await stopping;
});

/**
 * @case a store that does not page strictly after the cursor
 * @preconditions a store whose scan ignores `after`, and more due records than one page
 * @expectedResult the sweep refuses the second page as stalled rather than looping forever */
test("a scan that does not advance past the cursor is refused, not looped", async () => {
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    wrappedStore((inner) => ({
      findExpired: (now, limit) => inner.findExpired(now, limit),
    })),
  ]);
  await app.start([app.route("r").from(manual).defer("a", -1).build()]);
  const store = app.host.service(CONTINUATIONS);
  for (let i = 0; i < 12; i++)
    await store.create(`orphan#${i}`, parked(i, "gone"));
  // Raced, then stopped: a sweep that loops instead of refusing must end when the application stops, or the failure is never flushed.
  const stall = new Promise<never>((_, reject) =>
    setTimeout(() => reject(Error("no stall detected")), 500),
  );
  try {
    await expect(
      Promise.race([app.runtime.sweep({ pageSize: 10 }), stall]),
    ).rejects.toThrow("SCAN_STALLED");
  } finally {
    await app.stop();
  }
});
