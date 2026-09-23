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
  allRuns,
  continueWith,
  durableStore,
  CONTINUATIONS,
  RECORDS,
  SqliteRecords,
  type AtomicStore,
  type Continuation,
  type ContinuationStore,
  type Exchange,
  type Source,
  type Step,
  type StepOutcome,
  type Write,
} from "../../src/v2/index.ts";

/**
 * Round 7e review probes. Every test here is a CHARACTERISATION: it asserts
 * what the code at the reviewed head does, so the suite is green on that
 * head and each assertion is evidence. Which of these describe a defect,
 * and against which shipped guarantee, is stated in the README and in
 * `reviews/FABLE-ROUND-7E.md`; nothing here asserts desired behaviour.
 */

const temp = (name: string) =>
  mkdtempSync(join(tmpdir(), `rc-7e-review-${name}-`));
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
const parked = (
  expiresAt: number | undefined,
  routeId = "r",
  body: unknown = 1,
): Continuation => ({
  codec: 2,
  routeId,
  site: "s",
  frames: [],
  tail: "x",
  parkedAt: 0,
  ...(expiresAt !== undefined ? { expiresAt } : {}),
  exchange: { id: "e", routeId, body, headers: {} },
});
const step = (
  id: string,
  fn: Step["execute"],
  children: readonly Step[] = [],
) => instruction("routecraft.operations", id, fn, children);

/**
 * @case F1 `.authorize()` with no grants
 * @preconditions the gate installed, a route carrying `.authorize()` with an empty grant list, an anonymous delivery
 * @expectedResult the exchange is admitted with no principal at all: the empty ask is a no-op, where shipped `authorize()` still requires an authentic principal */
test("F1: an empty `.authorize()` admits an anonymous exchange", async () => {
  const app = application([operations, principals, auth]);
  await app.start([
    app
      .route("r")
      .authorize()
      .from(manual)
      .transform((_, ex) => ex.auth.principal?.subject ?? "nobody")
      .build(),
  ]);
  const result = await app.runtime.deliver("r", 0);
  expect(result.status).toBe("completed");
  expect(result.exchanges[0]?.body).toBe("nobody");
  await app.stop();
});

/**
 * @case F2 the whole ingress header bag is persisted
 * @preconditions alice parks; bob resumes with a bearer-shaped header beside his principal; the suffix completes; then a second, permitted caller repeats the resume
 * @expectedResult the cached outcome holds bob's raw header and his full grant list under `routecraft.deferral.ingress`, and the duplicate reply hands that bag to the later caller */
test("F2: the resumer's whole header set, bearer included, is written to the store and replayed to a duplicate caller", async () => {
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
      .transform((x) => x)
      .build(),
  ]);
  const alice = withPrincipal(
    {},
    { subject: "alice", grants: ["pay"], lent: [] },
  );
  const bob = withPrincipal(
    { authorization: "Bearer s3cret-token" },
    { subject: "bob", grants: ["pay", "admin"], lent: [] },
  );
  const carol = withPrincipal(
    {},
    { subject: "carol", grants: ["pay"], lent: [] },
  );
  const id = (await app.runtime.deliver("r", 0, alice)).deferrals[0]!;
  expect((await app.runtime.resume(id, { headers: bob })).status).toBe(
    "completed",
  );
  const raw = await app.host.service(RECORDS).get(`record/${id}`);
  const stored = JSON.stringify(raw?.value);
  expect(stored).toContain("Bearer s3cret-token");
  expect(stored).toContain('"grants":["pay","admin"]');
  const again = await app.runtime.resume(id, { headers: carol });
  expect(again.status).toBe("duplicate");
  const ingress = again.exchanges[0]?.headers["routecraft.deferral.ingress"] as
    Record<string, unknown> | undefined;
  expect(ingress?.["authorization"]).toBe("Bearer s3cret-token");
  await app.stop();
});

/**
 * @case F3 the resumer is not on the record when the continuation fails
 * @preconditions alice parks; bob resumes; the suffix throws
 * @expectedResult the record carries no trace of bob: the only carrier of the resumer is a header on a live exchange, and a failed outcome caches no exchanges */
test("F3: a failed continuation leaves no record of who resumed it", async () => {
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
      .from(manual)
      .defer("a")
      .transform(() => {
        throw Error("payment failed");
      })
      .build(),
  ]);
  const id = (
    await app.runtime.deliver(
      "r",
      0,
      withPrincipal({}, { subject: "alice", grants: [], lent: [] }),
    )
  ).deferrals[0]!;
  await expect(
    app.runtime.resume(id, {
      headers: withPrincipal({}, { subject: "bob", grants: [], lent: [] }),
    }),
  ).rejects.toThrow("payment failed");
  const record = await app.host.service(CONTINUATIONS).get(id);
  expect(record?.state).toBe("resumed");
  expect(record?.outcome?.status).toBe("failed");
  expect(JSON.stringify(record)).not.toContain("bob");
  await app.stop();
});

/**
 * @case F4 the parked body is shown at the door before the gate decides
 * @preconditions an unrelated plugin with an admission handler that sorts ahead of the gate; an identity-free resume of a protected record
 * @expectedResult the handler reads the parked body off `info.resume.deferred` while the resume is refused */
test("F4: an admission handler ahead of the gate sees the parked body of a resume the gate then refuses", async () => {
  const leaked: unknown[] = [];
  const audit = infrastructure({
    id: "acme.audit",
    bind: (c) =>
      c.contribute({
        kind: "handler",
        id: "log",
        point: "admission",
        survival: allRuns,
        handle(ex, info) {
          if (info.resume) leaked.push(info.resume.deferred.body);
          return { kind: "allow", exchange: ex };
        },
      }),
  });
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    principals,
    auth,
    audit,
  ]);
  await app.start([
    app
      .route("r")
      .authorize("pay")
      .from(manual)
      .defer("a")
      .transform((x) => x)
      .build(),
  ]);
  const id = (
    await app.runtime.deliver(
      "r",
      { iban: "NL00SECRET", amount: 1_000_000 },
      withPrincipal({}, { subject: "alice", grants: ["pay"], lent: [] }),
    )
  ).deferrals[0]!;
  const order = app.host
    .ordered(app.host.contributions)
    .filter((c) => c.kind === "handler" && c.point === "admission")
    .map((c) => `${c.owner}/${c.id}`);
  expect(order).toEqual(["acme.audit/log", "routecraft.auth/authorize"]);
  expect((await app.runtime.resume(id)).status).toBe("refused");
  expect(leaked).toEqual([{ iban: "NL00SECRET", amount: 1_000_000 }]);
  await app.stop();
});

/**
 * @case F5 the route is resolved before the door
 * @preconditions a record for a route this application lacks; an identity-free resume
 * @expectedResult the caller is told the route is unknown, by the kernel, before any admission handler ran */
test("F5: a resume of an orphaned record discloses the missing route before admission", async () => {
  let admitted = 0;
  const door = infrastructure({
    id: "acme.door",
    bind: (c) =>
      c.contribute({
        kind: "handler",
        id: "count",
        point: "admission",
        survival: allRuns,
        handle(ex) {
          admitted++;
          return { kind: "allow", exchange: ex };
        },
      }),
  });
  const app = application([operations, deferral, sqlite(":memory:"), door]);
  await app.start([app.route("r").from(manual).defer("a").build()]);
  await app.host
    .service(CONTINUATIONS)
    .create("orphan#1", parked(undefined, "gone"));
  await expect(app.runtime.resume("orphan#1")).rejects.toThrow(
    "[kernel] UNKNOWN_ROUTE: gone",
  );
  expect(admitted).toBe(0);
  await app.stop();
});

/** An atomic store that can slow one kind of write down, to open a race window on purpose. */
function slowStore(inner: AtomicStore, delayMs: number) {
  let slow = false;
  const store: AtomicStore & { slow(on: boolean): void } = {
    slow: (on) => {
      slow = on;
    },
    get: (key) => inner.get(key),
    keys: (prefix) => inner.keys(prefix),
    async write(writes: readonly Write[], conditions) {
      const resuming = writes.some(
        (w) =>
          !("delete" in w) &&
          (w.value as { state?: string } | undefined)?.state === "resumed",
      );
      if (slow && resuming) await new Promise((r) => setTimeout(r, delayMs));
      return inner.write(writes, conditions);
    },
    close: () => inner.close(),
  };
  return store;
}

/**
 * @case F6 no deadline check after the compare-and-swap
 * @preconditions a record due in 30 ms, a store whose `markResumed` write takes 80 ms, a resume that arrives in time
 * @expectedResult the continuation runs after the deadline has passed, where shipped revival re-checks the deadline after winning the transition */
test("F6: a resume that wins the CAS slowly runs the continuation past its deadline", async () => {
  const records = slowStore(new SqliteRecords(":memory:"), 80);
  const backend = infrastructure({
    id: "acme.records",
    provides: [RECORDS],
    bind: (c) => c.provide(RECORDS, records),
  });
  const app = application([operations, deferral, backend]);
  let ranAt: number | undefined;
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("a", 30)
      .transform((x) => {
        ranAt = Date.now();
        return x;
      })
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", 0)).deferrals[0]!;
  const expiresAt = (await app.host.service(CONTINUATIONS).get(id))!
    .continuation.expiresAt!;
  records.slow(true);
  const result = await app.runtime.resume(id);
  expect(result.status).toBe("completed");
  expect(ranAt).toBeDefined();
  expect(ranAt!).toBeGreaterThan(expiresAt);
  await app.stop();
});

/**
 * @case F7 a defer inside a nested path is swallowed
 * @preconditions a step that runs a declared child through `runPath`, and the child defers
 * @expectedResult the parent sees a path that neither failed nor dropped, the route completes, the deferral id is lost from the result, and the store holds a waiting record that a later resume runs */
test("F7: a defer inside runPath completes the route and strands a resumable record", async () => {
  const inner = step("inner", (ex) => ({
    kind: "defer",
    exchange: ex,
    request: { name: "approval", reason: "x" },
  }));
  const outer = step(
    "outer",
    async (ex, ctx) => {
      const path = await ctx.runPath({ steps: [inner], exchange: ex });
      return { kind: "continue", exchange: { ...ex, body: path } };
    },
    [inner],
  );
  const app = application([operations, deferral, sqlite(":memory:")]);
  const spec = app.route("r").from(manual).build();
  await app.start([{ ...spec, steps: [outer] }]);
  const result = await app.runtime.deliver("r", 0);
  expect(result.status).toBe("completed");
  expect(result.deferrals).toEqual([]);
  expect(result.exchanges[0]?.body).toEqual({ failed: false, dropped: false });
  const waiting = await app.host.service(RECORDS).keys("waiting/");
  expect(waiting).toHaveLength(1);
  const id = waiting[0]!.slice("waiting/".length);
  expect((await app.runtime.resume(id)).status).toBe("completed");
  await app.stop();
});

/**
 * @case F8 a branch that reorders its declared children cannot defer
 * @preconditions a branching step declaring children [a, b] that returns them as [b, a]; b defers
 * @expectedResult the defer itself faults, because the pending path is no longer a concatenation of list suffixes */
test("F8: a defer reached through a reordered branch faults with UNSTRUCTURED_PENDING", async () => {
  const a = step("a", (ex) => continueWith(ex));
  const b = step("b", (ex) => ({
    kind: "defer",
    exchange: ex,
    request: { name: "approval", reason: "x" },
  }));
  const branch = step(
    "branch",
    (ex): StepOutcome => ({ kind: "branch", exchange: ex, steps: [b, a] }),
    [a, b],
  );
  const app = application([operations, deferral, sqlite(":memory:")]);
  const spec = app.route("r").from(manual).build();
  await app.start([{ ...spec, steps: [branch] }]);
  await expect(app.runtime.deliver("r", 0)).rejects.toThrow(
    "UNSTRUCTURED_PENDING",
  );
  await app.stop();
});

/** Park a body through the real store and hand back what the resume delivers. */
async function roundTrip(body: unknown): Promise<unknown> {
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("a")
      .transform((x) => x)
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", body)).deferrals[0]!;
  const out = (await app.runtime.resume(id)).exchanges[0]?.body;
  await app.stop();
  return out;
}

/**
 * @case F9 codec: values the shipped rules refuse are dropped in silence
 * @preconditions bodies carrying an own `__proto__` key, a symbol-keyed property, a non-enumerable property, a named array property, and a Date with an extra property
 * @expectedResult each parks and resumes with the offending value missing, where `deferral/serialize.ts` refuses every one of them by path */
test("F9: the codec silently loses what the shipped serializer refuses", async () => {
  const proto = JSON.parse('{"__proto__":{"polluted":1},"x":1}') as Record<
    string,
    unknown
  >;
  expect(Object.keys(proto)).toEqual(["__proto__", "x"]);
  const revivedProto = (await roundTrip(proto)) as Record<string, unknown>;
  expect(Object.keys(revivedProto)).toEqual(["x"]);

  const symbolic = { x: 1, [Symbol("hidden")]: "secret" };
  expect(await roundTrip(symbolic)).toEqual({ x: 1 });

  const hidden = Object.defineProperty({ x: 1 }, "token", {
    value: "secret",
    enumerable: false,
  });
  expect(await roundTrip(hidden)).toEqual({ x: 1 });

  const named = Object.assign([1, 2], { note: "dropped" });
  expect(await roundTrip(named)).toEqual([1, 2]);

  const when = Object.assign(new Date("2026-01-01T00:00:00.000Z"), {
    tz: "Europe/Amsterdam",
  });
  const revivedDate = (await roundTrip(when)) as Date & { tz?: string };
  expect(revivedDate).toBeInstanceOf(Date);
  expect(revivedDate.tz).toBeUndefined();
});

/**
 * @case F10 codec: a corrupt date envelope is handed back as a plain object
 * @preconditions a stored exchange whose body is the reserved envelope with an unparseable instant
 * @expectedResult the resume completes with the raw envelope object as the body, where the shipped decoder refuses to revive it */
test("F10: a corrupt stored date envelope resumes as data", async () => {
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([app.route("r").from(manual).defer("a").build()]);
  const id = (await app.runtime.deliver("r", 0)).deferrals[0]!;
  const store = app.host.service(CONTINUATIONS);
  const saved = (await store.get(id))!.continuation;
  await store.create("corrupt#1", {
    ...saved,
    exchange: { ...saved.exchange, body: { $date: "not-an-instant" } },
  });
  const result = await app.runtime.resume("corrupt#1");
  expect(result.status).toBe("completed");
  expect(result.exchanges[0]?.body).toEqual({ $date: "not-an-instant" });
  await app.stop();
});

/**
 * @case F11 the boot report reads the wrong store when the continuation port is replaced
 * @preconditions a vendor plugin replacing `CONTINUATIONS` with its own store, which holds a stranded record and a waiting one
 * @expectedResult the deferral plugin's boot event reports nothing stranded and nothing pending, because it scans a store over `RECORDS` that nothing else uses */
test("F11: with a replaced continuation store the boot scan reports the wrong store", async () => {
  const vendorDb = new SqliteRecords(":memory:");
  const vendorStore: ContinuationStore = durableStore(vendorDb);
  await vendorStore.create("stranded#1", parked(undefined));
  await vendorStore.markResumed("stranded#1", Date.now());
  await vendorStore.create("waiting#1", parked(undefined));
  const vendor = infrastructure({
    id: "acme.store",
    provides: [CONTINUATIONS],
    replaces: [CONTINUATIONS],
    bind: (c) => c.provide(CONTINUATIONS, vendorStore),
  });
  const events: { name: string; data: unknown }[] = [];
  const app = application([
    operations,
    deferralPlugin({ interval: 0 }),
    sqlite(":memory:"),
    vendor,
    infrastructure({
      id: "acme.log",
      bind: (c) => c.observe((e) => events.push(e)),
    }),
  ]);
  await app.start([app.route("r").from(manual).defer("a").build()]);
  expect(app.host.selected.get(CONTINUATIONS.key)?.plugin.id).toBe(
    "acme.store",
  );
  expect(await vendorStore.resumedWithoutOutcome()).toEqual(["stranded#1"]);
  expect((await vendorStore.pending()).count).toBe(1);
  const boot = events.find((e) => e.name === "deferral:boot")?.data as {
    stranded: string[];
    pending: { count: number };
  };
  expect(boot.stranded).toEqual([]);
  expect(boot.pending.count).toBe(0);
  await app.stop();
  vendorDb.close();
});

/**
 * @case F12 a sweep in flight when the application stops
 * @preconditions an overdue record; a sweep that has taken its claim when `stop()` begins
 * @expectedResult the sweep fails, the record is left waiting under a claim, and the approver is never told: nothing awaits the pass or gates it before the store closes */
test("F12: stopping during a sweep abandons the retirement after the claim", async () => {
  const dir = temp("stop");
  try {
    const seen: string[] = [];
    let onClaim: (() => void) | undefined = undefined;
    const inner = new SqliteRecords(join(dir, "d.db"));
    const records: AtomicStore = {
      get: (k) => inner.get(k),
      keys: (p) => inner.keys(p),
      write(writes, conditions) {
        const claiming = writes.some(
          (w) =>
            !("delete" in w) &&
            w.key.startsWith("waiting/") &&
            (w.value as { claimed?: boolean }).claimed === true,
        );
        const won = inner.write(writes, conditions);
        if (claiming) onClaim?.();
        return won;
      },
      close: () => inner.close(),
    };
    const app = application([
      operations,
      deferral,
      infrastructure({
        id: "acme.records",
        provides: [RECORDS],
        bind: (c) => {
          c.provide(RECORDS, records);
          c.onDispose(() => records.close());
        },
      }),
      observer(seen),
    ]);
    await app.start([app.route("r").from(manual).defer("a", -1).build()]);
    const id = (await app.runtime.deliver("r", 0)).deferrals[0]!;
    let stopping: Promise<void> | undefined;
    onClaim = () => {
      stopping = app.stop();
    };
    const sweep = app.runtime.sweep();
    let failure = "";
    try {
      await sweep;
    } catch (e) {
      failure = String(e);
    }
    await stopping;
    expect(failure).toMatch(/NOT_RUNNING|closed/);
    const reopened = new SqliteRecords(join(dir, "d.db"));
    const record = reopened.get(`record/${id}`)?.value as {
      state: string;
      claimedAt?: number;
    };
    reopened.close();
    expect(record.state).toBe("waiting");
    expect(record.claimedAt).toBeDefined();
    expect(seen).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * @case F13 new traffic runs before the boot scan
 * @preconditions a source that emits during subscription; a store holding an overdue record for the route
 * @expectedResult the new delivery starts before the deferral plugin's boot event, where the shipped sweeper's scan is awaited before the context is ready */
test("F13: a source delivers before the boot scan has retired what came due while the process was down", async () => {
  const dir = temp("boot-order");
  try {
    const db = new SqliteRecords(join(dir, "d.db"));
    await durableStore(db).create("overdue#1", parked(1));
    db.close();
    const events: string[] = [];
    const eager: Source = {
      owner: "application",
      async subscribe(emit) {
        await emit("new traffic");
        return () => {};
      },
    };
    const app = application([
      operations,
      deferralPlugin({ interval: 0 }),
      sqlite(join(dir, "d.db")),
      infrastructure({
        id: "acme.log",
        bind: (c) => c.observe((e) => events.push(e.name)),
      }),
    ]);
    await app.start([
      app
        .route("r")
        .from(eager)
        .transform((x) => x)
        .build(),
    ]);
    expect(events.indexOf("exchange:started")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("exchange:started")).toBeLessThan(
      events.indexOf("deferral:boot"),
    );
    await app.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * @case F14 no default deadline
 * @preconditions `.defer()` without a ttl
 * @expectedResult the record has no `expiresAt`, so nothing ever retires it, where the shipped context applies a 72 hour default */
test("F14: a defer without a ttl never comes due", async () => {
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([app.route("r").from(manual).defer("a").build()]);
  const id = (await app.runtime.deliver("r", 0)).deferrals[0]!;
  const record = await app.host.service(CONTINUATIONS).get(id);
  expect(record?.continuation.expiresAt).toBeUndefined();
  expect(
    (await app.runtime.sweep({ now: Number.MAX_SAFE_INTEGER })).visited,
  ).toBe(0);
  await app.stop();
});

/**
 * @case F15 the resumer must satisfy the requester's policy
 * @preconditions a route gated on `request`; alice (request) parks it; bob holds `approve` only, carol holds `request`
 * @expectedResult bob is refused at the door and carol admitted: the door re-applies the route's own `.authorize()` to the resumer, and no approver policy distinct from it exists */
test("F15: the door applies the deferred route's requester grants to the resumer", async () => {
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
      .authorize("request")
      .from(manual)
      .defer("a")
      .transform(() => "done")
      .build(),
  ]);
  const grant = (subject: string, g: string) =>
    withPrincipal({}, { subject, grants: [g], lent: [] });
  const id = (await app.runtime.deliver("r", 0, grant("alice", "request")))
    .deferrals[0]!;
  expect(
    (await app.runtime.resume(id, { headers: grant("bob", "approve") })).status,
  ).toBe("refused");
  expect(
    (await app.runtime.resume(id, { headers: grant("carol", "request") }))
      .status,
  ).toBe("completed");
  await app.stop();
});

/**
 * @case F16 an unreadable record is denied, not refused
 * @preconditions a stored record whose codec version is not the current one
 * @expectedResult the resume settles it denied and drives the error channel, so the record cannot be read by a deployment that understands it */
test("F16: a record under another codec version is denied on first contact", async () => {
  const seen: string[] = [];
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    observer(seen),
  ]);
  await app.start([app.route("r").from(manual).defer("a").build()]);
  const id = (await app.runtime.deliver("r", 0)).deferrals[0]!;
  const store = app.host.service(CONTINUATIONS);
  const saved = (await store.get(id))!.continuation;
  await store.create("old#1", {
    ...saved,
    codec: 1,
  } as unknown as Continuation);
  await expect(app.runtime.resume("old#1")).rejects.toThrow("PLAN_MISMATCH");
  expect((await store.get("old#1"))?.state).toBe("denied");
  expect(seen).toEqual([`PLAN_MISMATCH:${saved.exchange.id}`]);
  await app.stop();
});

/**
 * @case F17 sweep paging retires a backlog larger than one page
 * @preconditions 150 overdue records for a present route
 * @expectedResult one sweep visits and retires all 150 across two pages */
test("F17: one sweep retires a backlog larger than its page size", async () => {
  const seen: string[] = [];
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    observer(seen),
  ]);
  await app.start([app.route("r").from(manual).defer("a", -1).build()]);
  for (let i = 0; i < 150; i++) await app.runtime.deliver("r", i);
  const report = await app.runtime.sweep();
  expect(report).toMatchObject({ visited: 150, retired: 150 });
  expect(seen).toHaveLength(150);
  await app.stop();
}, 20000);

/**
 * @case F18 the duplicate answer for a still-running first resume
 * @preconditions a first resume whose suffix is still running when a second arrives
 * @expectedResult the second is `duplicate` with no outcome and no exchanges, so a caller cannot tell "still running" from "died mid-run" */
test("F18: a duplicate during the first resume carries no outcome", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("a")
      .transform(async (x) => {
        await gate;
        return x;
      })
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", 7)).deferrals[0]!;
  const first = app.runtime.resume(id);
  await new Promise((r) => setTimeout(r, 20));
  const second = await app.runtime.resume(id);
  expect(second).toEqual({ status: "duplicate", exchanges: [], deferrals: [] });
  release();
  expect((await first).status).toBe("completed");
  await app.stop();
});

void ((ex: Exchange) => ex);
