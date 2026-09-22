import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Application,
  application,
  infrastructure,
  instruction,
  continueWith,
  allRuns,
  operations,
  resilience,
  deferral,
  sqlite,
  auth,
  principals,
  manual,
  withPrincipal,
  PRINCIPAL_HEADER,
  ENFORCEMENT,
  CONTINUATIONS,
  type Step,
  type RouteSpec,
  type Handler,
} from "../../src/v2/index.ts";

/**
 * Corrections from rounds six and seven.
 *
 * Every test here closes a gap a review found by mutation or by probing the
 * shipped framework. The continuation tests replace round six's claim-lease
 * tests, which encoded a misreading: the shipped resume is a compare-and-swap
 * out of waiting, a duplicate is answered from the cache, a half-run
 * continuation is reported and never re-run, and the lease heals expiry
 * NOTIFICATIONS, not continuations. See `reviews/FABLE-REVIEW.md` A1.
 */

const worker = infrastructure({ id: "worker" });
const step = (id: string, execute: Step["execute"]) =>
  instruction("worker", id, execute);
const route = (id: string, tags: readonly string[]): RouteSpec => ({
  id,
  owner: "worker",
  version: "1",
  tags,
  steps: [step(`${id}-body`, (ex) => continueWith(ex))],
  options: {},
});
const handler = (
  id: string,
  point: Handler["point"],
  log: string[],
  selector?: Handler["selector"],
  survival: Handler["survival"] = allRuns,
) =>
  infrastructure({
    id,
    bind: (c) =>
      c.contribute({
        kind: "handler",
        id,
        point,
        survival,
        ...(selector ? { selector } : {}),
        handle: (ex) => {
          log.push(`${id}:${ex.routeId}`);
          return { kind: "allow", exchange: ex };
        },
      }),
  });
const temp = (label: string) =>
  mkdtempSync(join(tmpdir(), `routecraft-${label}-`));

/**
 * @case tag selector excludes
 * @preconditions one tagged route and one untagged route, one tag-selected handler
 * @expectedResult the handler runs only on the tagged route */
test("a tag selector excludes a route that does not carry the tag", async () => {
  const log: string[] = [];
  const app = new Application([
    worker,
    handler("tagged", "entry", log, { tag: "protected" }),
    handler("always", "entry", log),
  ]);
  await app.start([route("secure", ["protected"]), route("open", [])]);
  await app.runtime.deliver("secure", 1);
  await app.runtime.deliver("open", 1);
  await app.stop();
  expect(log).toEqual(["always:secure", "tagged:secure", "always:open"]);
});

/**
 * @case handler survival discriminates
 * @preconditions an entry handler declared normal-only, a route that defers and resumes
 * @expectedResult the handler runs on the first delivery and not on the resumed continuation */
test("a handler declining resume does not run on the resumed continuation", async () => {
  const dir = temp("survival");
  try {
    const log: string[] = [];
    const app = new Application([
      worker,
      deferral,
      sqlite(join(dir, "d.db"), "acme.disk", true),
      handler("normal-only", "entry", log, undefined, {
        normal: true,
        resume: false,
        debounce: false,
        errorChannel: false,
      }),
      handler("every-run", "entry", log),
    ]);
    const spec: RouteSpec = {
      id: "r",
      owner: "worker",
      version: "1",
      tags: [],
      steps: [
        step("park", (ex, context) =>
          context.kind === "resume"
            ? continueWith(ex)
            : {
                kind: "defer",
                exchange: ex,
                request: { name: "approval", reason: "wait" },
              },
        ),
      ],
      options: {},
    };
    await app.start([spec]);
    const parked = await app.runtime.deliver("r", 1);
    expect(parked.status).toBe("deferred");
    expect(log).toEqual(["every-run:r", "normal-only:r"]);
    expect((await app.runtime.resume(parked.deferrals[0]!)).status).toBe(
      "completed",
    );
    await app.stop();
    expect(log).toEqual(["every-run:r", "normal-only:r", "every-run:r"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * @case per-exchange continuation ids
 * @preconditions one route with one defer point, two deliveries
 * @expectedResult both park, under ids minted from their own exchange, and the facet predicts the id before parking */
test("one route parks any number of exchanges, each under its own id", async () => {
  const app = application([operations, deferral, sqlite(":memory:")]);
  const predicted: string[] = [];
  await app.start([
    app
      .route("r")
      .from(manual)
      .transform((b, ex) => {
        predicted.push(ex.deferral.id);
        return b;
      })
      .defer("approval")
      .transform((x) => x)
      .build(),
  ]);
  const first = await app.runtime.deliver("r", 1);
  const second = await app.runtime.deliver("r", 2);
  expect([first.status, second.status]).toEqual(["deferred", "deferred"]);
  expect(first.deferrals[0]).not.toBe(second.deferrals[0]);
  expect(predicted).toEqual([first.deferrals[0]!, second.deferrals[0]!]);
  expect(first.deferrals[0]).toMatch(/#1$/);
  expect(
    (await app.runtime.resume(second.deferrals[0]!)).exchanges[0]?.body,
  ).toBe(2);
  expect(
    (await app.runtime.resume(first.deferrals[0]!)).exchanges[0]?.body,
  ).toBe(1);
  await app.stop();
});

/**
 * Builds the same route under different surroundings, to show what the tail
 * hash is and is not sensitive to.
 */
function approvalRoute(
  path: string,
  suffix: (n: number) => number,
  extras: { plugin?: ReturnType<typeof infrastructure>; retry?: number } = {},
) {
  // Always a fifth plugin, so the tuple length is literal; which one differs between variants.
  const app = application([
    operations,
    resilience,
    deferral,
    sqlite(path),
    extras.plugin ?? infrastructure({ id: "acme.noop" }),
  ] as const);
  let chain = app.route("r");
  if (extras.retry) chain = chain.retry(extras.retry) as typeof chain;
  // The suffix callable is passed through as-is: its source text is what the approval authorises.
  const spec = chain
    .from(manual)
    .transform((n) => (n as number) + 1)
    .defer("approval")
    .transform(suffix)
    .build();
  return { app, spec };
}

/**
 * @case tail-only hash
 * @preconditions an exchange parked by one deployment, resumed by deployments that differ outside the tail
 * @expectedResult an unrelated plugin or a route option does not strand the approval; an edited suffix callable refuses it */
test("the plan hash covers the tail's step definitions and nothing else", async () => {
  const dir = temp("hash");
  try {
    const park = async () => {
      rmSync(join(dir, "h.db"), { force: true });
      const p = approvalRoute(join(dir, "h.db"), (n) => n * 2);
      await p.app.start([p.spec]);
      const id = (await p.app.runtime.deliver("r", 1)).deferrals[0]!;
      await p.app.stop();
      return id;
    };
    const attempt = async (
      variant: ReturnType<typeof approvalRoute>,
      id: string,
    ) => {
      await variant.app.start([variant.spec]);
      const out = await variant.app.runtime.resume(id).then(
        (r) => `resumed:${r.exchanges[0]?.body}`,
        (e) => String(e),
      );
      await variant.app.stop();
      return out;
    };
    const observer = infrastructure({
      id: "acme.metrics",
      bind: (c) =>
        c.contribute({
          kind: "handler",
          id: "count",
          point: "exit",
          survival: allRuns,
          handle: (ex) => ({ kind: "allow", exchange: ex }),
        }),
    });
    let id = await park();
    expect(
      await attempt(
        approvalRoute(join(dir, "h.db"), (n) => n * 2, { plugin: observer }),
        id,
      ),
    ).toBe("resumed:4");
    id = await park();
    expect(
      await attempt(
        approvalRoute(join(dir, "h.db"), (n) => n * 2, { retry: 3 }),
        id,
      ),
    ).toBe("resumed:4");
    id = await park();
    expect(
      await attempt(
        approvalRoute(join(dir, "h.db"), (n) => n * 1000),
        id,
      ),
    ).toContain("PLAN_MISMATCH");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * @case half-run continuation
 * @preconditions a record left resumed with no outcome, as a process that died mid-continuation leaves it
 * @expectedResult it is reported by resumedWithoutOutcome, a resume answers duplicate, the sweep ignores it, nothing re-runs */
test("a continuation whose resumer died is reported, never re-run", async () => {
  let ran = 0;
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("approval")
      .transform((x) => {
        ran++;
        return x;
      })
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", 1)).deferrals[0]!;
  const store = app.host.service(CONTINUATIONS);
  expect(await store.markResumed(id, 1_000)).toBe("won");
  expect(await store.resumedWithoutOutcome()).toEqual([id]);
  const again = await app.runtime.resume(id);
  expect(again.status).toBe("duplicate");
  expect(again.exchanges).toEqual([]);
  expect(
    (await app.runtime.sweep({ now: Number.MAX_SAFE_INTEGER })).retired,
  ).toBe(0);
  expect(ran).toBe(0);
  await app.stop();
});

/**
 * @case expiry notification survives a dead deliverer
 * @preconditions a parked exchange past its ttl, an expiry claim taken by a holder that dies
 * @expectedResult the sweep skips the live claim, the lease releases it, the next sweep delivers the nag once and settles the record */
test("the lease heals an expiry notification, and the nag is delivered exactly once after it", async () => {
  const seen: string[] = [];
  const observer = infrastructure({
    id: "acme.ops",
    bind: (c) =>
      c.contribute({
        kind: "handler",
        id: "expired",
        point: "error",
        survival: allRuns,
        handle: (ex, { error }) => {
          seen.push(`${ex.id}:${error?.message}`);
          return { kind: "allow", exchange: ex };
        },
      }),
  });
  const app = application([operations, deferral, sqlite(":memory:"), observer]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("approval", 1)
      .transform((x) => x)
      .build(),
  ]);
  const parked = await app.runtime.deliver("r", 1);
  const id = parked.deferrals[0]!;
  const store = app.host.service(CONTINUATIONS);
  const now = Date.now() + 10;
  // A sweeper elsewhere claimed delivery and died.
  expect(await store.claimExpiry(id, now)).toBe("won");
  // A live claim is exclusive: a second sweeper cannot take it.
  expect(await store.claimExpiry(id, now)).toBe("lost");
  expect((await app.runtime.sweep({ now })).retired).toBe(0);
  expect(seen).toEqual([]);
  // A claim younger than the lease deadline is still live and must not be released.
  expect(await store.releaseClaims(now - 1)).toBe(0);
  expect((await app.runtime.sweep({ now })).retired).toBe(0);
  expect(await store.releaseClaims(now)).toBe(1);
  expect((await app.runtime.sweep({ now })).retired).toBe(1);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain("EXPIRED");
  expect((await app.runtime.sweep({ now })).retired).toBe(0);
  expect((await store.get(id))?.state).toBe("expired");
  await expect(app.runtime.resume(id)).rejects.toThrow("RESUME_SETTLED");
  await app.stop();
});

const gateRoute = (
  app: Application<
    readonly [typeof operations, typeof principals, typeof auth]
  >,
) =>
  app
    .route("sink")
    .authorize("approve")
    .from(manual)
    .transform(
      (_, ex) =>
        `${ex.auth.principal?.subject}:${ex.auth.principal?.authentic}`,
    )
    .build();

/**
 * @case principal cannot be forged in a step
 * @preconditions a route gated on a grant, a caller step that writes its own principal into the header
 * @expectedResult the gate refuses, because the written object was never minted */
test("a step that writes its own principal cannot pass an authorize gate", async () => {
  const app = application([operations, principals, auth]);
  await app.start([
    gateRoute(app),
    app
      .route("caller")
      .from(manual)
      .step("escalate", async (ex, ctx) => {
        const forged = {
          ...ex,
          headers: {
            ...ex.headers,
            [PRINCIPAL_HEADER]: {
              subject: "mallory",
              grants: ["approve"],
              lent: [],
            },
          },
        };
        return {
          kind: "continue",
          exchange: {
            ...ex,
            body: (await ctx.dispatch("sink", forged)).status,
          },
        };
      })
      .build(),
  ]);
  const honest = await app.runtime.deliver(
    "sink",
    0,
    withPrincipal({}, { subject: "alice", grants: ["approve"], lent: [] }),
  );
  expect(honest.exchanges[0]?.body).toBe("alice:true");
  const forged = await app.runtime.deliver("caller", 0);
  expect(forged.exchanges[0]?.body).toBe("refused");
  await app.stop();
});

/**
 * @case restored principal is not authentic
 * @preconditions an exchange parked with a lent grant, resumed by a new process without an ingress identity, then with one
 * @expectedResult the stored identity is refused at the gate; the ingress identity is authorised */
test("a resumed continuation is authorised by its ingress, never by the stored principal", async () => {
  const dir = temp("restored");
  try {
    const build = () => {
      const app = application([
        operations,
        deferral,
        principals,
        auth,
        sqlite(join(dir, "d.db")),
      ]);
      const specs = [
        gateRoute(
          app as unknown as Application<
            readonly [typeof operations, typeof principals, typeof auth]
          >,
        ),
        app
          .route("flow")
          .from(manual)
          .defer("approval")
          .step("hop", async (ex, ctx) => ({
            kind: "continue",
            exchange: { ...ex, body: (await ctx.dispatch("sink", ex)).status },
          }))
          .build(),
      ];
      return { app, specs };
    };
    const one = build();
    await one.app.start(one.specs);
    const id = (
      await one.app.runtime.deliver(
        "flow",
        0,
        withPrincipal({}, { subject: "alice", grants: [], lent: ["approve"] }),
      )
    ).deferrals[0]!;
    await one.app.stop();
    const two = build();
    await two.app.start(two.specs);
    const store = two.app.host.service(CONTINUATIONS);
    expect(
      (await store.get(id))?.continuation.exchange.headers[PRINCIPAL_HEADER],
    ).toMatchObject({ subject: "alice" });
    // No ingress identity: the parked principal is a parse, not a credential.
    expect((await two.app.runtime.resume(id)).exchanges[0]?.body).toBe(
      "refused",
    );
    await two.app.stop();
    const three = build();
    await three.app.start(three.specs);
    // The same approval presented again is a duplicate, whatever identity it carries.
    expect(
      (
        await three.app.runtime.resume(id, {
          headers: withPrincipal(
            {},
            { subject: "bob", grants: ["approve"], lent: [] },
          ),
        })
      ).status,
    ).toBe("duplicate");
    await three.app.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * @case bodies are not cloned in flight
 * @preconditions a function, a stream and a class instance as bodies
 * @expectedResult each passes through a transform intact; only the defer boundary demands plain JSON */
test("an exchange body is arbitrary in flight and plain JSON only when parked", async () => {
  class Invoice {
    constructor(readonly total: number) {}
    vat() {
      return this.total * 0.21;
    }
  }
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([
    app
      .route("pass")
      .from(manual)
      .transform((b) => b)
      .build(),
    app
      .route("cls")
      .from(manual)
      .transform((b) => (b as Invoice).vat())
      .build(),
    app.route("park").from(manual).defer("hold").build(),
  ]);
  const fn = { handler: () => 1 };
  expect((await app.runtime.deliver("pass", fn)).exchanges[0]?.body).toBe(fn);
  const stream = new ReadableStream();
  expect((await app.runtime.deliver("pass", stream)).exchanges[0]?.body).toBe(
    stream,
  );
  expect(
    (await app.runtime.deliver("cls", new Invoice(100))).exchanges[0]?.body,
  ).toBe(21);
  await expect(app.runtime.deliver("park", fn)).rejects.toThrow(
    "NOT_PERSISTABLE",
  );
  await app.stop();
});

/**
 * @case bounded drain
 * @preconditions a step that never settles
 * @expectedResult stop returns after the deadline, naming what it abandoned, instead of waiting forever */
test("shutdown drains for a bounded time and then abandons uncooperative work", async () => {
  const app = application([operations]);
  await app.start([
    app
      .route("hang")
      .from(manual)
      .step("never", () => new Promise<never>(() => {}))
      .build(),
  ]);
  void app.runtime.deliver("hang", 1).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 5));
  const started = Date.now();
  await expect(app.runtime.stop(50)).rejects.toThrow("DRAIN_TIMEOUT");
  expect(Date.now() - started).toBeLessThan(1_000);
});

/**
 * @case dispatch is a fresh delivery
 * @preconditions a resumed run dispatches to a second route with a resume-declining entry handler
 * @expectedResult the target runs as a normal delivery, so the handler applies */
test("a dispatch from a resumed run enters the target as a normal delivery", async () => {
  const log: string[] = [];
  const app = new Application([
    worker,
    deferral,
    sqlite(":memory:"),
    handler(
      "normal-only",
      "entry",
      log,
      { routeId: "target" },
      {
        normal: true,
        resume: false,
        debounce: false,
        errorChannel: false,
      },
    ),
  ]);
  await app.start([
    route("target", []),
    {
      ...route("source", []),
      steps: [
        step("park", (ex, ctx) =>
          ctx.kind === "resume"
            ? ctx.dispatch("target", ex).then(() => continueWith(ex))
            : {
                kind: "defer",
                exchange: ex,
                request: { name: "x", reason: "x", reenter: true },
              },
        ),
      ],
    },
  ]);
  const id = (await app.runtime.deliver("source", 1)).deferrals[0]!;
  await app.runtime.resume(id);
  await app.stop();
  expect(log).toEqual(["normal-only:target"]);
});

/**
 * @case codec and pending are checked before anything leaves waiting
 * @preconditions copies of a real parked record with a future codec and with an unknown pending id
 * @expectedResult both refuse with PLAN_MISMATCH and nothing runs */
test("codec and pending are checked against the compiled route", async () => {
  let ran = 0;
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("approval")
      .transform((x) => {
        ran++;
        return x;
      })
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", 1)).deferrals[0]!;
  const store = app.host.service(CONTINUATIONS);
  const real = (await store.get(id))!.continuation;
  await store.create("future#1", { ...real, codec: 3 as unknown as 2 });
  await store.create("unknown#1", {
    ...real,
    frames: [{ list: "nope", from: 0 }],
  });
  await expect(app.runtime.resume("future#1")).rejects.toThrow("PLAN_MISMATCH");
  await expect(app.runtime.resume("unknown#1")).rejects.toThrow(
    "PLAN_MISMATCH",
  );
  expect(ran).toBe(0);
  await app.stop();
});

/**
 * @case two defer points in one exchange
 * @preconditions a route that parks twice
 * @expectedResult the second park is `#2` under the same exchange, and both resume in order */
test("an exchange with two defer points parks under #1 then #2", async () => {
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("first")
      .defer("second")
      .transform((x) => x)
      .build(),
  ]);
  const one = await app.runtime.deliver("r", 7);
  expect(one.deferrals[0]).toMatch(/#1$/);
  const two = await app.runtime.resume(one.deferrals[0]!);
  expect(two.status).toBe("deferred");
  expect(two.deferrals[0]).toBe(one.deferrals[0]!.replace(/#1$/, "#2"));
  expect((await app.runtime.resume(two.deferrals[0]!)).exchanges[0]?.body).toBe(
    7,
  );
  await app.stop();
});

/**
 * @case failed resume is recorded
 * @preconditions a suffix that throws on resume
 * @expectedResult the resume rejects, a second resume is a duplicate, and the record is not mistaken for a dead process */
test("a failed resume is recorded, so it is neither re-run nor reported as stranded", async () => {
  let attempts = 0;
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("approval")
      .transform(() => {
        attempts++;
        throw new Error("boom");
      })
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", 1)).deferrals[0]!;
  const store = app.host.service(CONTINUATIONS);
  await expect(app.runtime.resume(id)).rejects.toThrow("boom");
  expect(await store.resumedWithoutOutcome()).toEqual([]);
  expect((await store.get(id))?.outcome?.status).toBe("failed");
  expect((await app.runtime.resume(id)).status).toBe("duplicate");
  expect(attempts).toBe(1);
  await app.stop();
});

/**
 * @case second create under one id
 * @preconditions a continuation already stored under an id
 * @expectedResult a second create is refused and the first survives untouched */
test("a second create under one id is refused, never overwritten", async () => {
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([app.route("r").from(manual).defer("a").build()]);
  const id = (await app.runtime.deliver("r", "first")).deferrals[0]!;
  const store = app.host.service(CONTINUATIONS);
  const real = (await store.get(id))!.continuation;
  await expect(
    store.create(id, {
      ...real,
      exchange: { ...real.exchange, body: "second" },
    }),
  ).rejects.toThrow("DUPLICATE_DEFERRAL");
  expect((await store.get(id))?.continuation.exchange.body).toBe("first");
  await app.stop();
});

/**
 * @case observers see their own copy
 * @preconditions two observers, the first mutating the event it receives
 * @expectedResult the second sees the emitter's value */
test("observers see their own copy of an event, so one cannot rewrite what the next sees", async () => {
  const seen: string[] = [];
  const vandal = infrastructure({
    id: "a.vandal",
    bind: (c) =>
      c.observe((event) => {
        if (event.name === "exchange:started")
          (event.data as { route: string }).route = "rewritten";
      }),
  });
  const witness = infrastructure({
    id: "b.witness",
    bind: (c) =>
      c.observe((event) => {
        if (event.name === "exchange:started")
          seen.push((event.data as { route: string }).route);
      }),
  });
  const app = application([operations, vandal, witness]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .transform((x) => x)
      .build(),
  ]);
  await app.runtime.deliver("r", 1);
  await app.stop();
  expect(seen).toEqual(["r"]);
});

/**
 * @case same id with a different function
 * @preconditions a branch returning a step that reuses a declared child's id with another execute
 * @expectedResult refused as UNDECLARED_BRANCH */
test("a branch cannot substitute a different function under a declared child id", async () => {
  const child = step("child", (ex) => continueWith(ex));
  const impostor: Step = {
    ...child,
    execute: (ex) => continueWith({ ...ex, body: "impostor" }),
  };
  const app = new Application([worker]);
  await app.start([
    {
      ...route("r", []),
      steps: [
        instruction(
          "worker",
          "fork",
          (ex) => ({ kind: "branch", exchange: ex, steps: [impostor] }),
          [child],
        ),
      ],
    },
  ]);
  await expect(app.runtime.deliver("r", 0)).rejects.toThrow(
    "UNDECLARED_BRANCH",
  );
  await app.stop();
});

/**
 * @case two contributions claim one anchor
 * @preconditions a second plugin contributing a wrapper on the resilience retry anchor
 * @expectedResult boot refuses with DUPLICATE_ANCHOR naming the prior owner */
test("two contributions claiming one anchor are refused at boot", async () => {
  const { RETRY } = await import("../../src/v2/index.ts");
  const squatter = infrastructure({
    id: "acme.squatter",
    bind: (c) =>
      c.contribute({
        kind: "wrapper",
        id: "also-retry",
        anchor: RETRY,
        survival: allRuns,
        bind: () => (next, run) => next(run),
      }),
  });
  const app = application([operations, resilience, squatter]);
  await expect(app.start([])).rejects.toThrow("DUPLICATE_ANCHOR");
});

/**
 * @case step reads only what its plugin declared
 * @preconditions a step whose plugin declared no requires, asking for an installed port
 * @expectedResult refused as UNDECLARED_REQUIRE naming the step's owner, while a declared plugin's step succeeds */
test("a step's require goes through its plugin's declaration, not the application's services", async () => {
  const { RECORDS } = await import("../../src/v2/index.ts");
  const declared = infrastructure({ id: "acme.declared", requires: [RECORDS] });
  const app = new Application([worker, declared, deferral, sqlite(":memory:")]);
  await app.start([
    {
      ...route("undeclared", []),
      steps: [
        step("peek", (ex, ctx) => {
          ctx.require(RECORDS);
          return continueWith(ex);
        }),
      ],
    },
    {
      ...route("declared", []),
      steps: [
        instruction("acme.declared", "peek", (ex, ctx) => {
          ctx.require(RECORDS);
          return continueWith(ex);
        }),
      ],
    },
  ]);
  await expect(app.runtime.deliver("undeclared", 0)).rejects.toThrow(
    "[worker] UNDECLARED_REQUIRE",
  );
  expect((await app.runtime.deliver("declared", 0)).status).toBe("completed");
  await app.stop();
});

/**
 * @case disposer registered during teardown
 * @preconditions a plugin whose stop hook registers a disposer
 * @expectedResult stop reports the late registration instead of silently dropping the cleanup */
test("a disposer registered during teardown is refused, not silently dropped", async () => {
  const late = infrastructure({
    id: "acme.late",
    stop(c) {
      c.onDispose(() => undefined);
    },
  });
  const app = application([operations, late]);
  await app.start([]);
  await expect(app.stop()).rejects.toThrow("late disposer");
});

/**
 * @case compiled against a frozen chain
 * @preconditions a running application
 * @expectedResult compiling another route is refused as FROZEN */
test("a route cannot be compiled after start", async () => {
  const app = application([operations]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .transform((x) => x)
      .build(),
  ]);
  expect(() =>
    app.runtime.compile(
      app
        .route("late")
        .from(manual)
        .transform((x) => x)
        .build(),
    ),
  ).toThrow("FROZEN");
  await app.stop();
});

/**
 * @case an authorization ask cannot fail open
 * @preconditions a route declaring the enforcement port as a requirement, no auth gate installed
 * @expectedResult the kernel refuses to compile the route, naming the port, instead of running it unprotected */
test("a route that requires authority does not boot without a provider of it", async () => {
  const app = new Application([worker]);
  await expect(
    app.start([
      {
        ...route("secret", []),
        requires: [ENFORCEMENT],
        options: { "auth.authorize": ["admin"] },
      },
    ]),
  ).rejects.toThrow("ROUTE_REQUIRES");
});

/**
 * @case refusal where it is not honoured
 * @preconditions handlers at exit and error that refuse, written past the compiler
 * @expectedResult the exit refusal fails the run naming the handler; the error refusal is recorded as secondary */
test("a refusal at exit or error is a named fault, never silently ignored", async () => {
  const refuser = (point: "exit" | "error") =>
    infrastructure({
      id: `refuser-${point}`,
      bind: (c) =>
        c.contribute({
          kind: "handler",
          id: "refuse",
          point,
          survival: allRuns,
          // The compiler forbids this; a JavaScript caller can still write it.
          handle: () =>
            ({ kind: "refuse", reason: "no" }) as unknown as {
              kind: "allow";
              exchange: never;
            },
        }),
    });
  const app = application([operations, refuser("exit")]);
  await app.start([
    app
      .route("ok")
      .from(manual)
      .transform((x) => x)
      .build(),
  ]);
  await expect(app.runtime.deliver("ok", 1)).rejects.toThrow(
    "[refuser-exit] REFUSE_UNSUPPORTED: exit: refuse",
  );
  await app.stop();
  const errApp = application([operations, refuser("error")]);
  await errApp.start([
    errApp
      .route("bad")
      .from(manual)
      .transform(() => {
        throw new Error("boom");
      })
      .build(),
  ]);
  const failure = await errApp.runtime.deliver("bad", 1).then(
    () => undefined,
    (e) => e as { secondary: { message: string }[] },
  );
  expect(failure?.secondary.map((f) => f.message)).toEqual([
    "[refuser-error] REFUSE_UNSUPPORTED: error: refuse",
  ]);
  await errApp.stop();
});

/**
 * @case owner-qualified strings
 * @preconditions two plugins naming a wrapper `audit`, one plugin naming two, two plugins sharing a namespace, a facet not named after its plugin, an option key without a namespace
 * @expectedResult only the last four are refused, each naming what collided */
test("strings are owner-qualified: ids per plugin, one namespace per plugin, one facet per namespace, namespaced option keys", async () => {
  const { RETRY, TIMEOUT } = await import("../../src/v2/index.ts");
  const wrapper = (anchor: typeof RETRY) => ({
    kind: "wrapper" as const,
    id: "audit",
    after: [{ anchor, presence: "ifPresent" as const }],
    survival: allRuns,
    bind:
      () =>
      (
        next: (
          run: import("../../src/v2/index.ts").Run,
        ) => Promise<import("../../src/v2/index.ts").RunResult>,
        run: import("../../src/v2/index.ts").Run,
      ) =>
        next(run),
  });
  const audit = (id: string, anchor: typeof RETRY) =>
    infrastructure({ id, bind: (c) => c.contribute(wrapper(anchor)) });
  const shared = application([
    operations,
    resilience,
    audit("acme.one", RETRY),
    audit("acme.two", TIMEOUT),
  ]);
  await shared.start([]);
  expect(
    shared.runtime.dump().contributions.filter((c) => c.id === "audit"),
  ).toHaveLength(2);
  await shared.stop();
  const twice = infrastructure({
    id: "acme.twice",
    bind: (c) => {
      c.contribute(wrapper(RETRY));
      c.contribute(wrapper(TIMEOUT));
    },
  });
  await expect(
    application([operations, resilience, twice]).start([]),
  ).rejects.toThrow("[acme.twice] DUPLICATE_CONTRIBUTION: audit");
  expect(
    () => new Application([worker, infrastructure({ id: "acme.worker" })]),
  ).toThrow("DUPLICATE_NAMESPACE");
  expect(
    () =>
      new Application([
        infrastructure({ id: "acme.tenant", facets: { principal: () => 1 } }),
      ]),
  ).toThrow(
    "[acme.tenant] FACET_NAMESPACE: principal: a facet must be named tenant",
  );
  const bare = application([operations]);
  await expect(
    bare.start([
      bare
        .route("r")
        .configure({ retry: 2 })
        .from(manual)
        .transform((x) => x)
        .build(),
    ]),
  ).rejects.toThrow("OPTION_NAMESPACE");
  const foreign = application([operations]);
  await expect(
    foreign.start([
      foreign
        .route("r")
        .configure({ "ghost.retry": 2 })
        .from(manual)
        .transform((x) => x)
        .build(),
    ]),
  ).rejects.toThrow("OPTION_NAMESPACE");
  const own = application([operations]);
  await own.start([
    own
      .route("r")
      .configure({ "route.note": "mine" })
      .from(manual)
      .transform((x) => x)
      .build(),
  ]);
  await own.stop();
});
