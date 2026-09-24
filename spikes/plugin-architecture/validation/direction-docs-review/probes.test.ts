import { test, expect } from "bun:test";
import {
  application,
  infrastructure,
  operations,
  resilience,
  deferral,
  sqlite,
  principals,
  auth,
  manual,
  allRuns,
  instruction,
  RECORDS,
  type Fault,
  type PluginContext,
} from "../../src/v2/index.ts";

/**
 * Probes for the direction-docs review (`reviews/OPUS-DIRECTION-DOCS.md`).
 * Each asserts what the proof of concept DOES at the reviewed head, so a
 * probe that passes is evidence for the finding it names, not a guarantee.
 */

const faultOf = async (work: Promise<unknown>): Promise<Fault> => {
  try {
    await work;
  } catch (e) {
    return e as Fault;
  }
  throw new Error("expected a fault");
};

const recorder = (events: string[]) =>
  infrastructure({
    id: "acme.recorder",
    bind: (c) => c.observe((e) => void events.push(e.name)),
  });

const refuser = (point: "admission" | "entry") =>
  infrastructure({
    id: `acme.${point}refuser`,
    bind: (c) =>
      c.contribute({
        kind: "handler",
        id: "no",
        point,
        survival: allRuns,
        handle: () => ({ kind: "refuse", reason: "no" }),
      }),
  });

const errorLog = (seen: string[]) =>
  infrastructure({
    id: "acme.errorlog",
    bind: (c) =>
      c.contribute({
        kind: "handler",
        id: "log",
        point: "error",
        survival: allRuns,
        handle: (ex, { error, kind }) => {
          seen.push(`${kind}:${error?.code}`);
          return { kind: "allow", exchange: ex };
        },
      }),
  });

/**
 * @case D1: a refused run emits no terminal event
 * @preconditions an admission handler that refuses every delivery; an observer recording every event name
 * @expectedResult the run returns `refused`, `exchange:started` is emitted, and no `exchange:refused` is (page 03 lists it as a kernel event)
 */
test("D1: a refusal at admission emits exchange:started and no exchange:refused", async () => {
  const events: string[] = [];
  const app = application([operations, recorder(events), refuser("admission")]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .transform(() => 1)
      .build(),
  ]);
  const result = await app.runtime.deliver("r", 0);
  expect(result.status).toBe("refused");
  expect(events).toContain("exchange:started");
  expect(events).not.toContain("exchange:refused");
  await app.stop();
});

/**
 * @case D2: a refusal at entry does not reach the error ring
 * @preconditions one entry handler that refuses, one error handler that records what it hears; a second app refusing at admission instead
 * @expectedResult the admission refusal is heard by the error ring as REFUSED; the entry refusal is not heard at all (the exchange-path figure says both are)
 */
test("D2: the error ring hears an admission refusal but not an entry refusal", async () => {
  const atAdmission: string[] = [];
  const a = application([
    operations,
    refuser("admission"),
    errorLog(atAdmission),
  ]);
  await a.start([
    a
      .route("r")
      .from(manual)
      .transform(() => 1)
      .build(),
  ]);
  expect((await a.runtime.deliver("r", 0)).status).toBe("refused");
  expect(atAdmission).toEqual(["normal:REFUSED"]);
  await a.stop();
  const atEntry: string[] = [];
  const b = application([operations, refuser("entry"), errorLog(atEntry)]);
  await b.start([
    b
      .route("r")
      .from(manual)
      .transform(() => 1)
      .build(),
  ]);
  expect((await b.runtime.deliver("r", 0)).status).toBe("refused");
  expect(atEntry).toEqual([]);
  await b.stop();
});

/**
 * @case D3: the error ring sits outside the wrapper chain
 * @preconditions a route with `.retry(2)` whose step throws on the first attempt only; an error handler recording what it hears
 * @expectedResult the run completes and the error ring hears nothing: the retry wrapper absorbed the failure before the ring could park it
 */
test("D3: a retried failure never reaches the error ring", async () => {
  const seen: string[] = [];
  let attempts = 0;
  const app = application([operations, resilience, errorLog(seen)]);
  await app.start([
    app
      .route("r")
      .retry(2)
      .from(manual)
      .transform(() => {
        if (++attempts === 1) throw new Error("transient");
        return "ok";
      })
      .build(),
  ]);
  const result = await app.runtime.deliver("r", 0);
  expect(result.exchanges[0]?.body).toBe("ok");
  expect(attempts).toBe(2);
  expect(seen).toEqual([]);
  await app.stop();
});

/**
 * @case D4: the exit ring runs only over exchanges that completed
 * @preconditions an exit handler recording each call; one route that parks, one that throws
 * @expectedResult the exit handler is never called for a deferred or a failed run
 */
test("D4: exit does not run on deferred or failed runs", async () => {
  const exits: string[] = [];
  const exit = infrastructure({
    id: "acme.exit",
    bind: (c) =>
      c.contribute({
        kind: "handler",
        id: "x",
        point: "exit",
        survival: allRuns,
        handle: (ex) => {
          exits.push(ex.routeId);
          return { kind: "allow", exchange: ex };
        },
      }),
  });
  const app = application([operations, deferral, sqlite(":memory:"), exit]);
  await app.start([
    app.route("parks").from(manual).defer("hold").build(),
    app
      .route("fails")
      .from(manual)
      .transform(() => {
        throw new Error("x");
      })
      .build(),
    app
      .route("done")
      .from(manual)
      .transform(() => 1)
      .build(),
  ]);
  expect((await app.runtime.deliver("parks", 0)).status).toBe("deferred");
  await faultOf(app.runtime.deliver("fails", 0));
  await app.runtime.deliver("done", 0);
  expect(exits).toEqual(["done"]);
  await app.stop();
});

/**
 * @case D5: every plugin holds the resume verb
 * @preconditions a third-party plugin that keeps `ctx.execution` from bind; a route with no `.authorize()` and no `.resumable()`, with principals and auth installed
 * @expectedResult the stranger resumes the parked exchange with no identity at all and it completes: the door is only as strong as the route's declaration, and `execution` is a socket the four-sockets page does not name
 */
test("D5: any plugin can resume any continuation on a route that declares no door", async () => {
  let execution: PluginContext["execution"] | undefined;
  const stranger = infrastructure({
    id: "acme.stranger",
    bind: (c) => {
      execution = c.execution;
    },
  });
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    principals,
    auth,
    stranger,
  ]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("approve")
      .transform(() => "paid")
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", 0)).deferrals[0]!;
  const result = await execution!.resume(id, { headers: {} });
  expect(result.status).toBe("completed");
  expect(result.exchanges[0]?.body).toBe("paid");
  await app.stop();
});

/**
 * @case D6: a missing provider fails as MISSING_PORT at construction
 * @preconditions the deferral plugin installed without any provider of the atomic records port
 * @expectedResult `application()` throws MISSING_PORT naming the deferral plugin, not the UNAVAILABLE_PORT the installation figure shows at resolution
 */
test("D6: resolution names MISSING_PORT", () => {
  let caught: Fault | undefined;
  try {
    application([operations, deferral]);
  } catch (e) {
    caught = e as Fault;
  }
  expect(caught?.code).toBe("MISSING_PORT");
  expect(caught?.plugin).toBe("routecraft.deferral");
});

/**
 * @case D7: the store the packed fixture installs replaces the records port, not the continuation port
 * @preconditions `sqlite(":memory:", "acme.store", true)` as in `validation/round-two/external.fixture.ts`
 * @expectedResult `dump()` shows acme.store selected for `records.atomic@1`, and the deferral plugin still provides `execution.continuations@2`
 */
test("D7: acme.store replaces records.atomic, not execution.continuations", async () => {
  const app = application([
    operations,
    deferral,
    sqlite(":memory:", "acme.store", true),
  ]);
  await app.start([]);
  const providers = app.runtime.dump().providers;
  expect(providers).toContainEqual({
    port: RECORDS.name,
    plugin: "acme.store",
    replacement: true,
  });
  expect(providers).toContainEqual({
    port: "execution.continuations@2",
    plugin: "routecraft.deferral",
    replacement: false,
  });
  await app.stop();
});

/**
 * @case D8: a wrapper that declares allRuns runs on the error channel
 * @preconditions a wrapper with survival allRuns recording run kinds; a route told about a failure through `errorChannel`
 * @expectedResult the wrapper sees `errorChannel`: "nothing in the chain runs on the error channel" is a property of the first-party wrappers' survival, not of the kernel
 */
test("D8: a third-party wrapper can run on the error channel", async () => {
  const kinds: string[] = [];
  const wrap = infrastructure({
    id: "acme.wrap",
    bind: (c) =>
      c.contribute({
        kind: "wrapper",
        id: "w",
        survival: allRuns,
        bind: () => async (next, run) => {
          kinds.push(run.kind);
          return next(run);
        },
      }),
  });
  const app = application([operations, wrap]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .transform(() => 1)
      .build(),
  ]);
  const { Fault: F } = await import("../../src/v2/index.ts");
  await faultOf(
    app.runtime.errorChannel(
      "r",
      { id: "x", routeId: "r", body: 0, headers: {} },
      new F("acme", "E", "told"),
    ),
  );
  expect(kinds).toEqual(["errorChannel"]);
  await app.stop();
});

/**
 * @case D9: a plugin-declared point name need not sit under its namespace
 * @preconditions a plugin `acme.stranger` (namespace `stranger`) declaring a point named `acme:inspect`, as the page-06 example does
 * @expectedResult the application constructs: point names are not namespaced, unlike facets, options and events
 */
test("D9: point names are not checked against the owner's namespace", () => {
  const OWNER = Symbol("inspect");
  const p = infrastructure({
    id: "acme.stranger",
    points: [
      {
        name: "acme:inspect" as never,
        owner: OWNER,
        refuse: true,
        defer: false,
      },
    ],
  });
  expect(() => application([operations, p])).not.toThrow();
  void instruction;
});

/**
 * @case D10: unanchored handlers at one point are ordered by owner id
 * @preconditions the `auth` gate and a third-party admission handler, neither naming an anchor; the stranger's id sorts before `routecraft.auth`
 * @expectedResult the stranger's handler runs first and sees a delivery the gate is about to refuse; `auth` declares no anchor a stranger could name to land after it
 */
test("D10: a stranger's admission handler runs before the gate because of its name", async () => {
  const seen: string[] = [];
  const early = infrastructure({
    id: "acme.early",
    bind: (c) =>
      c.contribute({
        kind: "handler",
        id: "peek",
        point: "admission",
        survival: allRuns,
        handle: (ex) => {
          seen.push("acme.early saw it");
          return { kind: "allow", exchange: ex };
        },
      }),
  });
  const app = application([operations, principals, auth, early]);
  await app.start([
    app
      .route("r")
      .authorize("admin")
      .from(manual)
      .transform(() => 1)
      .build(),
  ]);
  const order = app.runtime
    .dump()
    .contributions.filter((c) => c.kind === "handler")
    .map((c) => `${c.owner}/${c.id}`);
  expect(order).toEqual(["acme.early/peek", "routecraft.auth/authorize"]);
  const result = await app.runtime.deliver("r", 0, {});
  expect(result.status).toBe("refused");
  expect(seen).toEqual(["acme.early saw it"]);
  await app.stop();
});
