import { test, expect } from "bun:test";
import {
  Application,
  application,
  infrastructure,
  operations,
  resilience,
  manual,
  instruction,
  continueWith,
  port,
  anchor,
  allRuns,
  Fault,
  SqliteRecords,
  RECORDS,
  sqlite,
  deferral,
  RETRY,
  TIMEOUT,
  type Step,
  type PluginContext,
  type RouteSpec,
  type Exchange,
  type RunResult,
  type Handler,
  type HandlerPoints,
} from "../../src/v2/index.ts";
const worker = infrastructure({ id: "worker" });
const route = (
  steps: readonly Step[],
  id = "r",
  options: Record<string, unknown> = {},
): RouteSpec => ({
  id,
  owner: "worker",
  version: "1",
  tags: ["protected"],
  steps,
  options,
});
const step = (
  id: string,
  execute: Step["execute"],
  children: readonly Step[] = [],
) => instruction("worker", id, execute, children);
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
const delay = () => new Promise((r) => setTimeout(r, 5));
/**
 * @case outcomes
 * @preconditions nested public instructions
 * @expectedResult exact effects, no suffix after halt */
test("continue, complete, drop, public branch, fanOut and takePending schedule exact suffixes", async () => {
  const trace: string[] = [];
  const child = step("child", (ex) => {
    trace.push("child");
    return continueWith(ex);
  });
  const branch = step(
    "branch",
    (ex) => ({ kind: "branch", exchange: ex, steps: [child] }),
    [child],
  );
  const split = step("split", (ex) => ({
    kind: "fanOut",
    exchanges: [
      { ...ex, body: 1 },
      { ...ex, body: 2 },
    ],
  }));
  const join = step("join", (ex, ctx) => {
    const siblings = ctx.takePending(() => true);
    trace.push(`${ex.body}+${siblings.map((e) => e.body).join()}`);
    return continueWith(ex);
  });
  const app = application([worker]);
  await app.start([
    route([branch, split, join]),
    route(
      [step("complete", (ex) => ({ kind: "complete", exchange: ex })), child],
      "complete",
    ),
    route([step("drop", () => ({ kind: "drop" })), child], "drop"),
  ]);
  const r = await app.runtime.deliver("r", 0);
  expect(r.exchanges.map((e) => e.body)).toEqual([1]);
  expect(trace).toEqual(["child", "1+2"]);
  expect((await app.runtime.deliver("complete", 0)).status).toBe("completed");
  expect((await app.runtime.deliver("drop", 0)).status).toBe("dropped");
  expect(trace).toEqual(["child", "1+2"]);
  await app.stop();
});
/**
 * @case source wiring
 * @preconditions source emits during subscribe
 * @expectedResult processed and unsubscribed */
test("source really emits and shutdown unsubscribes", async () => {
  let result: RunResult | undefined,
    stopped = false;
  const app = application([operations]);
  const r = app
    .route("source")
    .from({
      owner: "outside.source",
      async subscribe(emit: (body: number) => Promise<RunResult>) {
        result = await emit(5);
        return () => {
          stopped = true;
        };
      },
    })
    .transform((n) => n + 1)
    .build();
  await app.start([r]);
  expect(result?.exchanges[0]?.body).toBe(6);
  await app.stop();
  expect(stopped).toBe(true);
});
/**
 * @case substitution
 * @preconditions alternative declares replacement under own ID
 * @expectedResult selected provider and scoped access */
test("replacement under own identity, duplicate refusal, undeclared access and unique tokens", async () => {
  const contract = port<number>("number@1"),
    other = port<string>("number@1");
  expect(contract.key).not.toBe(other.key);
  const first = infrastructure({
      id: "first",
      provides: [contract],
      bind: (c) => c.provide(contract, 1),
    }),
    replacement = infrastructure({
      id: "acme.number",
      provides: [contract],
      replaces: [contract],
      bind: (c) => c.provide(contract, 2),
    });
  const seen: number[] = [];
  const consumer = infrastructure({
    id: "consumer",
    requires: [contract],
    bind: (c) => {
      seen.push(c.require(contract));
    },
  });
  const app = application([consumer, first, replacement]);
  await app.start([]);
  expect(seen).toEqual([2]);
  expect(app.runtime.dump().providers[0]).toEqual({
    port: "number@1",
    plugin: "acme.number",
    replacement: true,
  });
  await app.stop();
  expect(() => application([first, { ...first, id: "second" }])).toThrow(
    "first, second",
  );
  const bad = application([
    first,
    infrastructure({
      id: "spy",
      bind: (c) => {
        c.require(contract);
      },
    }),
  ]);
  await expect(bad.start([])).rejects.toThrow("[spy] UNDECLARED_REQUIRE");
  expect(() =>
    application([first, infrastructure({ id: "alien", requires: [other] })]),
  ).toThrow("PORT_IDENTITY");
});
/**
 * @case rollback
 * @preconditions failed acquisition and multiple throwing disposers
 * @expectedResult all cleanup, dependency last, primary preserved */
test("rollback and teardown aggregate with consumers stopped before providers close", async () => {
  const log: string[] = [],
    p = port<number>("p");
  const provider = infrastructure({
    id: "provider",
    provides: [p],
    bind(c) {
      c.provide(p, 1);
      c.onDispose(() => {
        log.push("provider closed");
      });
    },
    stop() {
      log.push("provider stop");
    },
  });
  const consumer = infrastructure({
    id: "consumer",
    requires: [p],
    bind(c) {
      c.onDispose(() => {
        log.push("last");
        throw Error("last cleanup");
      });
      c.onDispose(() => {
        log.push("first");
        throw Error("first cleanup");
      });
    },
    stop(c) {
      expect(c.require(p)).toBe(1);
      log.push("consumer stop");
      throw Error("stop error");
    },
  });
  const app = application([consumer, provider]);
  await app.start([]);
  let failure: unknown;
  try {
    await app.stop();
  } catch (e) {
    failure = e;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toHaveLength(3);
  expect(log).toEqual([
    "consumer stop",
    "first",
    "last",
    "provider stop",
    "provider closed",
  ]);
  log.length = 0;
  const broken = application([
    provider,
    infrastructure({
      id: "failure",
      requires: [p],
      bind(c) {
        c.onDispose(() => {
          log.push("partial");
          throw Error("cleanup");
        });
        throw Error("primary");
      },
    }),
  ]);
  try {
    await broken.start([]);
    throw Error("accepted");
  } catch (e) {
    expect((e as Fault).message).toContain("[failure] BIND");
    expect((e as Fault).message).toContain("primary");
    expect((e as Fault).secondary).toHaveLength(1);
  }
  expect(log).toEqual(["partial", "provider stop", "provider closed"]);
});
/**
 * @case observers
 * @preconditions throwing sync/async observers alter subscriptions
 * @expectedResult exchange succeeds, snapshot order, faults named */
test("observers cannot abort execution; subscriptions are snapshotted", async () => {
  const seen: string[] = [];
  let context!: PluginContext,
    added = false;
  const app = application([
    worker,
    infrastructure({
      id: "observer",
      bind(c) {
        context = c;
        c.observe(() => {
          seen.push("first");
          if (!added) {
            added = true;
            c.observe(() => {
              seen.push("late");
            });
          }
          throw Error("sync");
        });
        c.observe(async () => {
          seen.push("second");
          throw Error("async");
        });
      },
    }),
  ]);
  await app.start([route([])]);
  app.host.emit("probe", {});
  expect(seen).toEqual(["first", "second"]);
  await delay();
  expect(app.host.faults.map((f) => f.plugin)).toEqual([
    "observer",
    "observer",
  ]);
  expect((await app.runtime.deliver("r", 1)).status).toBe("completed");
  expect(() =>
    context.contribute({
      kind: "handler",
      point: "entry",
      id: "late",
      survival: allRuns,
      handle: (ex) => ({ kind: "allow", exchange: ex }),
    }),
  ).toThrow("[observer] FROZEN");
  await app.stop();
});
/**
 * @case immutable contributions
 * @preconditions original descriptor changed after bind
 * @expectedResult compiled behavior unchanged */
test("descriptor mutation cannot bypass freeze and contribution ids are owner-qualified", async () => {
  const h: Handler = {
    kind: "handler",
    id: "h",
    point: "entry",
    survival: allRuns,
    handle: (ex) => ({ kind: "allow", exchange: { ...ex, body: 2 } }),
  };
  const app = application([
    worker,
    infrastructure({ id: "owner", bind: (c) => c.contribute(h) }),
  ]);
  await app.start([route([])]);
  h.handle = () => {
    throw Error("mutated");
  };
  expect((await app.runtime.deliver("r", 1)).exchanges[0]?.body).toBe(2);
  await app.stop();
  // Ids are owner-qualified: two plugins may both contribute an `h`; one plugin may not contribute it twice.
  const shared = application([
    infrastructure({ id: "one", bind: (c) => c.contribute(h) }),
    infrastructure({ id: "two", bind: (c) => c.contribute(h) }),
  ]);
  await shared.start([]);
  await shared.stop();
  const twice = application([
    infrastructure({
      id: "one",
      bind: (c) => {
        c.contribute(h);
        c.contribute(h);
      },
    }),
  ]);
  await expect(twice.start([])).rejects.toThrow(
    "[one] DUPLICATE_CONTRIBUTION: h",
  );
});
/**
 * @case handlers
 * @preconditions shuffled plugins and route/tag selectors
 * @expectedResult order, composed decoration, refusal short circuits */
test("four handlers use selectors, deterministic order, compositional decoration and refusal", async () => {
  async function run(reverse: boolean) {
    const log: string[] = [];
    const make = <K extends keyof HandlerPoints>(
      id: string,
      point: K,
      fn: Handler<K>["handle"],
      selector: Handler["selector"] = { tag: "protected" },
    ) =>
      infrastructure({
        id,
        bind: (c) =>
          c.contribute({
            kind: "handler",
            id,
            point,
            survival: allRuns,
            selector,
            handle: fn,
          } as Handler<K>),
      });
    const plugins = [
      make("a", "admission", (ex) => {
        log.push("a");
        return {
          kind: "allow",
          exchange: { ...ex, body: Number(ex.body) + 1 },
        };
      }),
      make("b", "admission", (ex) => {
        log.push(`b:${ex.body}`);
        return Number(ex.body) > 2
          ? { kind: "refuse", reason: "quota" }
          : { kind: "allow", exchange: { ...ex, body: Number(ex.body) * 2 } };
      }),
      make(
        "c",
        "entry",
        (ex) => {
          log.push(`entry:${ex.body}`);
          return { kind: "allow", exchange: ex };
        },
        { routeId: "r" },
      ),
      make("d", "exit", (ex) => {
        log.push(`exit:${ex.body}`);
        return { kind: "allow", exchange: ex };
      }),
    ];
    const app = new Application([
      worker,
      ...(reverse ? plugins.reverse() : plugins),
    ]);
    await app.start([route([]), route([], "other")]);
    expect((await app.runtime.deliver("r", 1)).exchanges[0]?.body).toBe(4);
    expect((await app.runtime.deliver("r", 9)).status).toBe("refused");
    await app.runtime.deliver("other", 1);
    await app.stop();
    return log;
  }
  const log = await run(false);
  expect(log).toEqual([
    "a",
    "b:2",
    "entry:4",
    "exit:4",
    "a",
    "b:10",
    "a",
    "b:2",
    "exit:4",
  ]);
  expect(await run(true)).toEqual(log);
});
/**
 * @case error precedence
 * @preconditions error handler throws
 * @expectedResult primary retained and later handler runs */
test("a failing error handler cannot replace primary or skip subsequent handlers", async () => {
  const seen: string[] = [];
  const app = application([
    worker,
    infrastructure({
      id: "errors",
      bind(c) {
        for (const id of ["a", "b"])
          c.contribute({
            kind: "handler",
            id,
            point: "error",
            survival: allRuns,
            handle(ex, { error }) {
              seen.push(`${id}:${error?.plugin}`);
              if (id === "a") throw Error("secondary");
              return { kind: "allow", exchange: ex };
            },
          });
      },
    }),
  ]);
  await app.start([
    route([
      step("bad", () => {
        throw Error("primary");
      }),
    ]),
  ]);
  try {
    await app.runtime.deliver("r", 0);
    throw Error("accepted");
  } catch (e) {
    expect((e as Fault).message).toContain("[worker] STEP: Error: primary");
    expect((e as Fault).secondary[0]?.plugin).toBe("errors");
  }
  expect(seen).toEqual(["a:worker", "b:worker"]);
  await app.stop();
});
/**
 * @case timeout
 * @preconditions work released after reported failure
 * @expectedResult fenced effect and result suppressed */
test("timeout cancels, suppresses late result and rejects a late guarded side effect", async () => {
  const g = gate();
  let effect = 0;
  const app = application([worker, resilience]);
  await app.start([
    route(
      [
        step("slow", async (ex, ctx) => {
          await g.promise;
          ctx.commit(() => {
            effect++;
          });
          return continueWith(ex);
        }),
      ],
      "r",
      { "resilience.timeout": 5 },
    ),
  ]);
  await expect(app.runtime.deliver("r", 0)).rejects.toThrow("TIMEOUT");
  g.release();
  await delay();
  expect(effect).toBe(0);
  await app.stop();
});
/**
 * @case route resources
 * @preconditions two routes, overlapping calls and repeated failures
 * @expectedResult independent persistent controllers */
test("concurrency and breaker state persist per route", async () => {
  const g = gate();
  const slow = step("slow", async (ex) => {
    await g.promise;
    return continueWith(ex);
  });
  const app = application([worker, resilience]);
  await app.start([
    route([slow], "a", { "resilience.concurrency": 1 }),
    route([slow], "b", { "resilience.concurrency": 1 }),
    route(
      [
        step("fail", () => {
          throw Error("bad");
        }),
      ],
      "breaker",
      { "resilience.breaker": 1 },
    ),
    route([], "healthy", { "resilience.breaker": 1 }),
  ]);
  const a = app.runtime.deliver("a", 1),
    b = app.runtime.deliver("b", 2);
  await delay();
  const contender = app.runtime.deliver("a", 3).then(
    () => "accepted",
    (error) => String(error),
  );
  await delay();
  g.release();
  expect(await contender).toContain("CONCURRENCY");
  expect((await a).exchanges[0]?.body).toBe(1);
  expect((await b).exchanges[0]?.body).toBe(2);
  await expect(app.runtime.deliver("breaker", 0)).rejects.toThrow("bad");
  await expect(app.runtime.deliver("breaker", 0)).rejects.toThrow(
    "CIRCUIT_OPEN",
  );
  expect(app.runtime.status("breaker")).toEqual({
    state: "circuit-broken",
    owner: "routecraft.resilience",
    reason: "failure threshold",
  });
  expect((await app.runtime.deliver("healthy", 0)).status).toBe("completed");
  await app.stop();
});
/**
 * @case scopes
 * @preconditions pending exchange and streaming completion
 * @expectedResult stop waits for both before disposal */
test("drain owns streaming response after the step returns", async () => {
  const stream = gate(),
    entered = gate();
  const log: string[] = [];
  const app = application([
    infrastructure({
      id: "worker",
      stop() {
        log.push("closed");
      },
    }),
  ]);
  await app.start([
    route([
      step("stream", (ex, ctx) => {
        ctx.track(stream.promise);
        entered.release();
        return continueWith(ex);
      }),
    ]),
  ]);
  let completed = false;
  const delivery = app.runtime.deliver("r", 1).then((r) => {
    completed = true;
    return r;
  });
  await entered.promise;
  const stopping = app.stop();
  await delay();
  expect(log).toEqual([]);
  expect(completed).toBe(false);
  stream.release();
  await delivery;
  await stopping;
  expect(log).toEqual(["closed"]);
});
/**
 * @case detached
 * @preconditions captured downstream and error channel
 * @expectedResult prefix once, suffix at both detached kinds */
test("debounce and errorChannel execute the captured suffix with explicit survival", async () => {
  const captured: ((ex: Exchange) => Promise<RunResult>)[] = [];
  const kinds: string[] = [];
  let prefix = 0,
    suffix = 0;
  let saved!: Exchange;
  const app = application([
    worker,
    infrastructure({
      id: "watch",
      bind: (c) =>
        c.contribute({
          kind: "handler",
          id: "watch",
          point: "entry",
          survival: allRuns,
          handle(ex, { kind }) {
            kinds.push(kind);
            return { kind: "allow", exchange: ex };
          },
        }),
    }),
  ]);
  await app.start([
    route([
      step("capture", (ex, ctx) => {
        prefix++;
        saved = ex;
        captured.push(
          ctx.captureDownstream("debounce"),
          ctx.captureDownstream("errorChannel"),
        );
        return { kind: "drop" };
      }),
      step("suffix", (ex) => {
        suffix++;
        return continueWith(ex);
      }),
    ]),
  ]);
  await app.runtime.deliver("r", 0);
  expect(suffix).toBe(0);
  await captured[0]!(saved);
  await captured[1]!(saved);
  expect([prefix, suffix]).toEqual([1, 2]);
  expect(kinds).toEqual(["normal", "debounce", "errorChannel"]);
  await app.stop();
});
/**
 * @case DSL
 * @preconditions all categories and separate contexts
 * @expectedResult actual retries in both scopes, typed facets, immutable siblings */
test("installed DSL executes all four categories and two retry scopes in one route", async () => {
  let first = 0,
    last = 0;
  const app = application([
    operations,
    resilience,
    deferral,
    sqlite(":memory:"),
  ]);
  const root = app
    .route<{ trace: string }>("dsl")
    .title("hello")
    .retry(2)
    .from({ ...manual } as import("../../src/v2/index.ts").Source<number>);
  const r = root
    .retry(2)
    .delay(1)
    .transform((n, ex) => {
      expect(typeof ex.deferral.request).toBe("function");
      if (++first === 1) throw Error("step retry");
      return n + 1;
    })
    .transform((n) => {
      if (++last === 1) throw Error("route retry");
      return n * 2;
    })
    .build();
  await app.start([r]);
  expect((await app.runtime.deliver("dsl", 2)).exchanges[0]?.body).toBe(6);
  expect([first, last]).toEqual([3, 2]);
  expect(r.options?.["operations.title"]).toBe("hello");
  expect(root.build().steps).toHaveLength(0);
  await app.stop();
  const lean = application([operations]);
  await lean.start([
    lean
      .route("lean")
      .from(manual)
      .transform((_, ex) => "deferral" in ex)
      .build(),
  ]);
  expect((await lean.runtime.deliver("lean", 0)).exchanges[0]?.body).toBe(
    false,
  );
  await lean.stop();
});
/**
 * @case anchors
 * @preconditions contract-owned anchor and shuffled insertion
 * @expectedResult external wrapper between retry and timeout */
test("anchors survive replacement and missing optional contracts are reported", async () => {
  const log: string[] = [];
  const absent = anchor(port<true>("absent@1"), "optional");
  const stranger = infrastructure({
    id: "acme.audit",
    bind: (c) =>
      c.contribute({
        kind: "wrapper",
        id: "audit",
        after: [{ anchor: RETRY, presence: "required" }],
        before: [
          { anchor: TIMEOUT, presence: "required" },
          { anchor: absent, presence: "ifPresent" },
        ],
        survival: allRuns,
        bind: () => async (next, run) => {
          log.push("audit");
          return next(run);
        },
      }),
  });
  const replacement = {
    ...resilience,
    id: "acme.resilience",
    replaces: resilience.provides ?? [],
  };
  const app = application([worker, stranger, replacement]);
  await app.start([route([])]);
  await app.runtime.deliver("r", 0);
  const dump = app.runtime.dump();
  expect(dump.contributions.map((x) => x.id)).toEqual([
    "breaker",
    "retry",
    "audit",
    "timeout",
    "concurrency",
  ]);
  expect(dump.unmatched).toHaveLength(1);
  expect(log).toEqual(["audit"]);
  await app.stop();
  const c = port<true>("promised"),
    missing = anchor(c, "missing");
  const bad = application([
    infrastructure({
      id: "owner",
      provides: [c],
      bind(ctx) {
        ctx.provide(c, true);
        ctx.contribute({
          kind: "wrapper",
          id: "bad",
          before: [{ anchor: missing, presence: "ifPresent" }],
          survival: allRuns,
          bind: () => (next) => Promise.reject(next),
        });
      },
    }),
  ]);
  await expect(bad.start([])).rejects.toThrow("[owner] MISSING_ANCHOR");
});
/**
 * @case persistence laws
 * @preconditions versioned records
 * @expectedResult actual deletion, immutable read and ABA rejection */
test("atomic store deletes, copies values, rolls back throwing writes and rejects stale ABA versions", () => {
  const s = new SqliteRecords(":memory:");
  s.write([{ key: "x", value: { v: 1 } }]);
  const old = s.get("x")!;
  (old.value as { v: number }).v = 99;
  expect(s.get("x")?.value).toEqual({ v: 1 });
  s.write([{ key: "x", delete: true }]);
  expect(s.keys("")).toEqual([]);
  expect(s.get("x")).toBeUndefined();
  s.write([{ key: "x", value: 2 }]);
  expect(
    s.write([{ key: "x", value: 3 }], [{ key: "x", version: old.version }]),
  ).toBe(false);
  expect(() =>
    s.write(
      [
        { key: "primary", value: 1 },
        { key: "index", value: null },
      ],
      [],
      () => {
        throw Error("crash");
      },
    ),
  ).toThrow("crash");
  expect(s.keys("")).toEqual(["x"]);
  s.close();
});
/**
 * @case cancellation
 * @preconditions caller aborts before releasing uncooperative promise
 * @expectedResult immediate rejection, no downstream work or late fenced effect */
test("caller cancellation rejects before released work and suppresses outcome", async () => {
  const g = gate(),
    started = gate(),
    controller = new AbortController();
  let suffix = 0,
    effect = 0;
  const app = application([worker]);
  await app.start([
    route([
      step("blocked", async (ex, ctx) => {
        started.release();
        await g.promise;
        ctx.commit(() => effect++);
        return continueWith(ex);
      }),
      step("suffix", (ex) => {
        suffix++;
        return continueWith(ex);
      }),
    ]),
  ]);
  const running = app.runtime.deliver("r", 0, undefined, controller.signal);
  await started.promise;
  controller.abort(Error("cancelled"));
  await expect(running).rejects.toThrow("cancelled");
  g.release();
  await delay();
  expect([effect, suffix]).toEqual([0, 0]);
  await app.stop();
});
/**
 * @case isolated paths
 * @preconditions one child fails and another completes
 * @expectedResult caller survives and runPath reports drop */
test("runPaths isolates failures while fan-out schedules all children", async () => {
  const seen: unknown[] = [];
  const failed = step("failed", () => {
      throw Error("child");
    }),
    good = step("good", (ex) => {
      seen.push(ex.body);
      return continueWith(ex);
    }),
    drop = step("nested-drop", () => ({ kind: "drop" }));
  const nested = step(
    "nested",
    async (ex, ctx) => {
      await ctx.runPaths([
        { steps: [failed], exchange: ex },
        { steps: [good], exchange: ex },
      ]);
      expect(await ctx.runPath({ steps: [drop], exchange: ex })).toEqual({
        failed: false,
        dropped: true,
      });
      return continueWith(ex);
    },
    [failed, good, drop],
  );
  const split = step("split-all", (ex) => ({
    kind: "fanOut",
    exchanges: [
      { ...ex, body: 1 },
      { ...ex, body: 2 },
    ],
  }));
  const suffix = step("collect", (ex) => {
    seen.push(ex.body);
    return continueWith(ex);
  });
  const app = application([worker]);
  await app.start([route([nested, split, suffix])]);
  const result = await app.runtime.deliver("r", 0);
  expect(result.exchanges.map((e) => e.body)).toEqual([1, 2]);
  expect(seen).toEqual([0, 1, 2]);
  await app.stop();
});
/**
 * @case current resume policy
 * @preconditions approval exists but admission is revoked
 * @expectedResult refusal does not consume claim, later allowed resume executes once */
test("resume rechecks admission without consuming a refused claim", async () => {
  let allowed = false,
    count = 0;
  const app = application([
    operations,
    deferral,
    sqlite(":memory:"),
    infrastructure({
      id: "policy",
      bind: (c) =>
        c.contribute({
          kind: "handler",
          id: "policy",
          point: "admission",
          survival: allRuns,
          handle(ex, { kind }) {
            return kind === "resume" && !allowed
              ? { kind: "refuse", reason: "revoked" }
              : { kind: "allow", exchange: ex };
          },
        }),
    }),
  ]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("approval")
      .transform((x) => {
        count++;
        return x;
      })
      .build(),
  ]);
  const parked = await app.runtime.deliver("r", 1);
  const id = parked.deferrals[0]!;
  expect((await app.runtime.resume(id)).status).toBe("refused");
  expect(await app.host.service(RECORDS).keys("waiting/")).toEqual([
    `waiting/${id}`,
  ]);
  allowed = true;
  expect((await app.runtime.resume(id)).status).toBe("completed");
  // An approver double-clicks: the cached reply, and the suffix does not run again.
  expect((await app.runtime.resume(id)).status).toBe("duplicate");
  expect(count).toBe(1);
  await app.stop();
});
/**
 * @case named diagnostics
 * @preconditions invalid boot plans and runtime instructions
 * @expectedResult each failure names the responsible owner */
test("boot failure taxonomy and foreign instruction faults name responsible plugins", async () => {
  const p = port<number>("left"),
    q = port<number>("right");
  expect(() => application([worker, worker])).toThrow("[worker] DUPLICATE_ID");
  expect(() =>
    application([infrastructure({ id: "missing", requires: [p] })]),
  ).toThrow("[missing] MISSING_PORT");
  expect(() =>
    application([
      infrastructure({ id: "a", requires: [q], provides: [p] }),
      infrastructure({ id: "b", requires: [p], provides: [q] }),
    ]),
  ).toThrow("[a, b] CYCLE");
  await expect(
    application([infrastructure({ id: "unprovided", provides: [p] })]).start(
      [],
    ),
  ).rejects.toThrow("[unprovided] UNPROVIDED_PORT");
  await expect(
    application([
      infrastructure({
        id: "bad-start",
        start() {
          throw Error("broken");
        },
      }),
    ]).start([]),
  ).rejects.toThrow("[bad-start] START");
  const duplicates = application([worker]);
  await expect(
    duplicates.start([
      route([step("same", continueWith), step("same", continueWith)]),
    ]),
  ).rejects.toThrow("[worker] DUPLICATE_STEP");
  const source = application([worker]);
  await expect(
    source.start([
      {
        ...route([]),
        source: {
          owner: "acme.source",
          subscribe: async () => {
            throw Error("offline");
          },
        },
      },
    ]),
  ).rejects.toThrow("[acme.source] SOURCE_START");
  const dynamic = step("uncompiled", continueWith);
  const app = application([worker]);
  await app.start([
    route([
      step("bad-branch", (ex) => ({
        kind: "branch",
        exchange: ex,
        steps: [dynamic],
      })),
    ]),
    route(
      [
        step("park", (ex) => ({
          kind: "defer",
          exchange: ex,
          request: { name: "x", reason: "x" },
        })),
      ],
      "park",
    ),
  ]);
  await expect(app.runtime.deliver("r", 0)).rejects.toThrow(
    "[worker] UNDECLARED_BRANCH",
  );
  await expect(app.runtime.deliver("park", 0)).rejects.toThrow(
    "[worker] MISSING_CONTINUATION_STORE",
  );
  await app.stop();
});
/**
 * @case stranger status
 * @preconditions third-party route binding disables one route
 * @expectedResult exact owner/reason and another route still runs */
test("a stranger owns the disabled reason it sets", async () => {
  const plugin = infrastructure({
    id: "acme.maintenance",
    bind: (c) =>
      c.contribute({
        kind: "wrapper",
        id: "status",
        survival: allRuns,
        bind({ route, setStatus }) {
          if (route.id === "off") setStatus("disabled", "maintenance");
          return (next, run) => next(run);
        },
      }),
  });
  const app = application([worker, plugin]);
  await app.start([route([], "off"), route([], "on")]);
  expect(app.runtime.status("off")).toEqual({
    state: "disabled",
    owner: "acme.maintenance",
    reason: "maintenance",
  });
  await expect(app.runtime.deliver("off", 0)).rejects.toThrow(
    "[acme.maintenance] ROUTE_DISABLED",
  );
  expect((await app.runtime.deliver("on", 0)).status).toBe("completed");
  await app.stop();
});
/**
 * @case asynchronous replacement
 * @preconditions An async-only backend fronts SQLite and many resumes read concurrently.
 * @expectedResult All consumers await the contract and exactly one continuation executes.
 */
test("an asynchronous provider supports concurrent semantic resume", async () => {
  const backend = new SqliteRecords(":memory:");
  let effects = 0;
  const provider = infrastructure({
    id: "acme.remote",
    provides: [RECORDS],
    replaces: [RECORDS],
    bind(c) {
      c.provide(RECORDS, {
        async get(k) {
          await delay();
          return backend.get(k);
        },
        async keys(p) {
          return backend.keys(p);
        },
        async write(w, conditions) {
          await delay();
          return backend.write(w, conditions);
        },
        async close() {
          backend.close();
        },
      });
      c.onDispose(() => backend.close());
    },
  });
  const app = application([operations, deferral, provider]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("race")
      .transform((x) => {
        effects++;
        return x;
      })
      .build(),
  ]);
  const id = (await app.runtime.deliver("r", 1)).deferrals[0]!;
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () => app.runtime.resume(id)),
  );
  const statuses = results.map((x) =>
    x.status === "fulfilled" ? x.value.status : `rejected:${x.reason}`,
  );
  // One resume wins the compare-and-swap; every loser is answered as a duplicate, none re-runs.
  expect(statuses.filter((x) => x === "completed")).toHaveLength(1);
  expect(statuses.filter((x) => x === "duplicate")).toHaveLength(11);
  expect(effects).toBe(1);
  expect(await app.host.service(RECORDS).keys("waiting/")).toEqual([]);
  await app.stop();
});
/**
 * @case start and stop sequencing
 * @preconditions Source readiness precedes hooks and a stop arrives while a hook waits.
 * @expectedResult Teardown waits for hook settlement, source unsubscribes, context cannot restart.
 */
test("start hooks see sources ready; concurrent stop awaits hooks", async () => {
  const entered = gate(),
    release = gate();
  const log: string[] = [];
  const app = application([
    infrastructure({
      id: "worker",
      async start() {
        log.push("start");
        entered.release();
        await release.promise;
        log.push("settled");
      },
      stop() {
        log.push("stop");
      },
    }),
  ]);
  const boot = app.start([
    {
      ...route([]),
      source: {
        owner: "worker",
        subscribe: async () => {
          log.push("source");
          return () => {
            log.push("unsubscribe");
          };
        },
      },
    },
  ]);
  await entered.promise;
  const stop = app.stop();
  await delay();
  expect(log).toEqual(["source", "start"]);
  release.release();
  await boot;
  await stop;
  expect(log).toEqual(["source", "start", "settled", "unsubscribe", "stop"]);
  await expect(app.start([])).rejects.toThrow("LIFECYCLE");
});
/**
 * @case public error channel
 * @preconditions A plugin reports failure while no exchange is running and a circuit is open.
 * @expectedResult Error-channel survival bypasses the breaker and delivers the original named failure.
 */
test("a plugin can enter the error channel through its public lifecycle context", async () => {
  let ctx!: PluginContext;
  const seen: string[] = [];
  const app = application([
    worker,
    resilience,
    infrastructure({
      id: "reporter",
      bind(c) {
        ctx = c;
        c.contribute({
          kind: "handler",
          id: "error",
          point: "error",
          survival: allRuns,
          handle(ex, info) {
            seen.push(`${info.kind}:${info.error?.message}`);
            return { kind: "allow", exchange: ex };
          },
        });
      },
    }),
  ]);
  await app.start([
    route(
      [
        step("bad", () => {
          throw Error("open");
        }),
      ],
      "r",
      { "resilience.breaker": 1 },
    ),
  ]);
  await expect(app.runtime.deliver("r", 0)).rejects.toThrow("open");
  const error = new Fault("acme.sweeper", "EXPIRED", "approval expired");
  await expect(
    ctx.execution.errorChannel(
      "r",
      {
        id: "parked",
        routeId: "r",
        body: null,
        headers: {},
      },
      error,
    ),
  ).rejects.toBe(error);
  expect(seen.at(-1)).toBe(
    "errorChannel:[acme.sweeper] EXPIRED: approval expired",
  );
  await app.stop();
});
/**
 * @case simultaneous contexts
 * @preconditions Two live contexts share operation descriptors but install different plugins.
 * @expectedResult The lean context has no deferral facet while the other can park and resume.
 */
test("different installed sets coexist in two live contexts", async () => {
  const rich = application([operations, deferral, sqlite(":memory:")]),
    lean = application([operations]);
  await rich.start([
    rich
      .route("rich")
      .from(manual)
      .defer("a")
      .transform((x) => x)
      .build(),
  ]);
  await lean.start([
    lean
      .route("lean")
      .from(manual)
      .transform((_, ex) => "deferral" in ex)
      .build(),
  ]);
  const parked = await rich.runtime.deliver("rich", 42);
  expect(parked.status).toBe("deferred");
  expect((await lean.runtime.deliver("lean", 0)).exchanges[0]?.body).toBe(
    false,
  );
  expect(
    (await rich.runtime.resume(parked.deferrals[0]!)).exchanges[0]?.body,
  ).toBe(42);
  await Promise.all([rich.stop(), lean.stop()]);
});
/**
 * @case step timeout ownership
 * @preconditions A step-scope timeout abandons a gated callback that still holds resources.
 * @expectedResult Failure is reported, shutdown waits for release, and the fenced late effect cannot commit.
 */
test("step timeout drains abandoned work before disposing its provider", async () => {
  const g = gate();
  let effect = false,
    closed = false;
  const app = application([
    operations,
    resilience,
    infrastructure({
      id: "worker",
      stop() {
        closed = true;
      },
    }),
  ]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .timeout(2)
      .step("slow", async (ex, ctx) => {
        await g.promise;
        ctx.commit(() => {
          effect = true;
        });
        return continueWith(ex);
      })
      .build(),
  ]);
  await expect(app.runtime.deliver("r", 0)).rejects.toThrow("TIMEOUT");
  const stopping = app.stop();
  await delay();
  expect(closed).toBe(false);
  g.release();
  await stopping;
  expect([effect, closed]).toEqual([false, true]);
});
/**
 * @case partial source acquisition
 * @preconditions Subscribe acquires a resource, registers cleanup, then throws before returning an unsubscribe.
 * @expectedResult Source cleanup runs before its plugin dependencies are disposed.
 */
test("a source can register cleanup before subscription acquisition fails", async () => {
  const log: string[] = [];
  const app = application([
    infrastructure({
      id: "worker",
      stop() {
        log.push("plugin stopped");
      },
    }),
  ]);
  await expect(
    app.start([
      {
        ...route([]),
        source: {
          owner: "worker",
          async subscribe(_emit, scope) {
            scope.onDispose(() => {
              log.push("source closed");
            });
            throw Error("listen failed");
          },
        },
      },
    ]),
  ).rejects.toThrow("[worker] SOURCE_START");
  expect(log).toEqual(["source closed", "plugin stopped"]);
});
/**
 * @case application-scoped services in shared descriptors
 * @preconditions Two live contexts reuse one plugin, whose step and facet require the same port.
 * @expectedResult Each resolves its own provider, while an undeclared lookup is refused by owner.
 */
test("steps and lazy facets resolve declared services in their own application", async () => {
  const value = port<number>("value@1");
  const shared = infrastructure({
    id: "client",
    requires: [value],
    facets: {
      client: (
        _ex: Exchange,
        services: import("../../src/v2/index.ts").ServiceLookup,
      ) => ({ value: services.require(value) }),
    },
  });
  const provider = (n: number) =>
    infrastructure({
      id: `provider.${n}`,
      provides: [value],
      bind: (c) => c.provide(value, n),
    });
  const a = application([operations, shared, provider(1)]),
    b = application([operations, shared, provider(2)]);
  const raw: RouteSpec = {
    id: "step",
    owner: "client",
    version: "1",
    tags: [],
    steps: [
      instruction("client", "require", (ex, ctx) => ({
        kind: "continue",
        exchange: { ...ex, body: ctx.require(value) },
      })),
    ],
  };
  await a.start([
    raw,
    a
      .route("facet")
      .from(manual)
      .transform((_, ex) => ex.client.value)
      .build(),
  ]);
  await b.start([
    raw,
    b
      .route("facet")
      .from(manual)
      .transform((_, ex) => ex.client.value)
      .build(),
  ]);
  expect((await a.runtime.deliver("step", 0)).exchanges[0]?.body).toBe(1);
  expect((await b.runtime.deliver("step", 0)).exchanges[0]?.body).toBe(2);
  expect((await a.runtime.deliver("facet", 0)).exchanges[0]?.body).toBe(1);
  expect((await b.runtime.deliver("facet", 0)).exchanges[0]?.body).toBe(2);
  expect(() => a.host.requireFor("routecraft.operations", value)).toThrow(
    "[routecraft.operations] UNDECLARED_REQUIRE",
  );
  await Promise.all([a.stop(), b.stop()]);
});
/**
 * @case single descriptor for DSL and execution
 * @preconditions Resilience is omitted from one context and installed without operations in another.
 * @expectedResult Retry is absent when declined and executes when its owning descriptor is installed.
 */
test("resilience owns both its methods and its runtime wrappers", async () => {
  const lean = application([operations]);
  expect("retry" in lean.route("lean")).toBe(false);
  await lean.start([]);
  let attempts = 0;
  const app = application([resilience]);
  await app.start([
    app
      .route("r")
      .retry(2)
      .from(manual)
      .step("attempt", (ex) => {
        if (++attempts === 1) throw Error("retry me");
        return continueWith(ex);
      })
      .build(),
  ]);
  expect((await app.runtime.deliver("r", 0)).status).toBe("completed");
  expect(attempts).toBe(2);
  await Promise.all([lean.stop(), app.stop()]);
});
