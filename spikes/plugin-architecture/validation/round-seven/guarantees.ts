/* eslint-disable no-console -- Executable review evidence; each line is one checkable claim. */
/**
 * Round-seven probes: behaviours the shipped framework guarantees, checked
 * against what `src/v2` actually does. Each probe prints one line beginning
 * with the probe name and either `REGRESSION`, `HOLDS` or `INFO`, followed by
 * the observed fact. Nothing here asserts; the point is the observation.
 *
 * Ground truth is cited inline as `packages/routecraft/src/...` paths so a
 * reader can check the claim against the real contract rather than against
 * this file.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  application,
  infrastructure,
  operations,
  deferral,
  sqlite,
  manual,
  allRuns,
  SqliteRecords,
  durableStore,
  type Handler,
} from "../../src/v2/index.ts";

const dir = mkdtempSync(join(tmpdir(), "routecraft-round-seven-"));
const say = (name: string, verdict: string, detail: string) =>
  console.log(`${name.padEnd(28)} ${verdict.padEnd(10)} ${detail}`);
const message = (e: unknown) =>
  e instanceof Error ? e.message.split("\n")[0] : String(e);

/**
 * Shipped: a deferral id is `{exchangeId}#{sequence}`, minted per exchange
 * (`packages/routecraft/src/deferral/types.ts`, `DeferralListCursor` JSDoc;
 * `exchange-state.ts` `deferralIdOf`). Any number of exchanges may be parked
 * on one route at once.
 */
async function perRouteDeferralId() {
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("approval")
      .transform((x) => x)
      .build(),
  ]);
  const first = await app.runtime.deliver("r", 1);
  let second: string;
  try {
    second = (await app.runtime.deliver("r", 2)).status;
  } catch (e) {
    second = message(e);
  }
  say(
    "per-exchange deferral id",
    second.includes("DUPLICATE_DEFERRAL") ? "REGRESSION" : "HOLDS",
    `first delivery ${first.status}; second delivery: ${second}`,
  );
  await app.stop();
}

/**
 * Shipped: `continuationHash` covers ONLY the steps after the defer point
 * plus the resume schema (`packages/routecraft/src/deferral/hash.ts`, "Why
 * the tail and not the pipeline"), and it folds in the SOURCE TEXT of the
 * callables in that tail, so an edited suffix lambda is refused with RC5048.
 * The spike hashes every step id, every contribution and the route options,
 * and never reads a callable.
 */
async function planHashScope() {
  const path = join(dir, "hash.db");
  const build = (
    plugins: readonly Parameters<typeof application>[0][number][],
    suffix: (n: number) => number,
    prefix: (n: number) => number,
    options: { retry?: number } = {},
  ) => {
    const app = application([
      operations,
      deferral,
      sqlite(path),
      ...plugins,
    ] as const);
    let chain = app.route("r");
    if (options.retry) {
      // Route options are folded into the plan hash.
      chain = chain.configure({ retry: options.retry }) as typeof chain;
    }
    const spec = chain
      .from(manual)
      .transform((n: unknown) => prefix(n as number))
      .defer("approval")
      .transform((n) => suffix(n))
      .build();
    return { app, spec };
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

  const park = build(
    [],
    (n) => n * 2,
    (n) => n + 1,
  );
  await park.app.start([park.spec]);
  await park.app.runtime.deliver("r", 1);
  await park.app.stop();

  const attempt = async (
    label: string,
    variant: ReturnType<typeof build>,
  ): Promise<string> => {
    await variant.app.start([variant.spec]);
    let out: string;
    try {
      const r = await variant.app.runtime.resume("approval");
      out = `resumed, body ${JSON.stringify(r.exchanges[0]?.body)}`;
    } catch (e) {
      out = message(e);
    }
    await variant.app.stop();
    return `${label}: ${out}`;
  };

  // 1. Same route, one unrelated exit-observing plugin added.
  const a = await attempt(
    "unrelated plugin added",
    build(
      [observer],
      (n) => n * 2,
      (n) => n + 1,
    ),
  );
  say(
    "hash: unrelated plugin",
    a.includes("PLAN_MISMATCH") ? "REGRESSION" : "HOLDS",
    a,
  );
  // Re-park for the next variant, since a failed resume settles nothing but a
  // successful one would.
  const repark = async () => {
    rmSync(path, { force: true });
    const p = build(
      [],
      (n) => n * 2,
      (n) => n + 1,
    );
    await p.app.start([p.spec]);
    await p.app.runtime.deliver("r", 1);
    await p.app.stop();
  };

  // 2. Same route, the SUFFIX lambda edited (what the approval authorises).
  await repark();
  const b = await attempt(
    "suffix lambda edited",
    build(
      [],
      (n) => n * 1000,
      (n) => n + 1,
    ),
  );
  say(
    "hash: edited suffix",
    b.includes("resumed") ? "REGRESSION" : "HOLDS",
    `${b} (shipped refuses with RC5048)`,
  );

  // 3. Same route, a route option changed.
  await repark();
  const c = await attempt(
    "route option changed",
    build(
      [],
      (n) => n * 2,
      (n) => n + 1,
      { retry: 3 },
    ),
  );
  say(
    "hash: route option",
    c.includes("PLAN_MISMATCH") ? "REGRESSION" : "HOLDS",
    `${c} (shipped hashes the tail only)`,
  );
}

/**
 * Shipped: a duplicate resume returns `status: "duplicate"` with the cached
 * continuation result and re-runs nothing (`revive.ts` `unresumable`,
 * `types.ts` `SerializedOutcome`). An approver double-click or a redelivered
 * webhook is the normal case there.
 */
async function duplicateResume() {
  const app = application([operations, deferral, sqlite(":memory:")]);
  await app.start([
    app
      .route("r")
      .from(manual)
      .defer("approval")
      .transform((x) => x)
      .build(),
  ]);
  await app.runtime.deliver("r", 1);
  await app.runtime.resume("approval");
  let second: string;
  try {
    second = (await app.runtime.resume("approval")).status;
  } catch (e) {
    second = message(e);
  }
  say(
    "duplicate resume",
    second.includes("CLAIM_LOST") ? "REGRESSION" : "HOLDS",
    `second resume: ${second}`,
  );
  await app.stop();
}

/**
 * Shipped: a principal read back from storage is marked RESTORED and fails
 * `authorize()` with RC5043; only a principal minted by a trusted origin is
 * authentic, and authenticity is WeakSet membership that no code can forge
 * (`.standards/security.md` section 3, `auth/restored.ts`, `auth/authentic.ts`).
 * The spike's `Principal` is a plain object on the exchange: any step can
 * write one, and a persisted one is trusted unchanged after restart.
 */
async function principalForgery() {
  const seen: string[] = [];
  const gate = infrastructure({
    id: "acme.gate",
    bind: (c) =>
      c.contribute({
        kind: "handler",
        id: "authorize",
        point: "entry",
        selector: { routeId: "sink" },
        survival: allRuns,
        handle: (ex) => {
          seen.push(
            `${ex.routeId}:${ex.principal.subject}:${ex.principal.grants.join(",")}`,
          );
          return ex.principal.grants.includes("admin")
            ? { kind: "allow", exchange: ex }
            : { kind: "refuse", reason: "not admin" };
        },
      }),
  });
  const app = application([operations, gate]);
  await app.start([
    app
      .route("sink")
      .from(manual)
      .transform((x) => x)
      .build(),
    app
      .route("caller")
      .from(manual)
      .step("escalate", async (ex, ctx) => {
        // A plain step rewrites identity; nothing in core can tell.
        const forged = {
          ...ex,
          principal: { subject: "mallory", grants: ["admin"], lent: [] },
        };
        const result = await ctx.dispatch("sink", forged);
        return { kind: "continue", exchange: { ...ex, body: result.status } };
      })
      .build(),
  ]);
  const result = await app.runtime.deliver("caller", 0, {
    subject: "alice",
    grants: [],
    lent: [],
  });
  say(
    "principal forgery",
    result.exchanges[0]?.body === "completed" ? "REGRESSION" : "HOLDS",
    `dispatch to a route gated on grant "admin" returned ${JSON.stringify(result.exchanges[0]?.body)}; gate saw ${JSON.stringify(seen)}`,
  );
  await app.stop();
}

/**
 * Shipped: an exchange body is arbitrary in flight; only the DEFER path
 * requires plain JSON and refuses otherwise with RC5042
 * (`types.ts` `SerializedExchange`). The spike `structuredClone`s the
 * exchange at every step boundary (`runtime.ts` `wireExchange`).
 */
async function nonCloneableBodies() {
  const app = application([operations]);
  class Invoice {
    constructor(readonly total: number) {}
    vat() {
      return this.total * 0.21;
    }
  }
  await app.start([
    app
      .route("fn")
      .from(manual)
      .transform((b) => b)
      .build(),
    app
      .route("cls")
      .from(manual)
      .transform((b) => (b as Invoice).vat())
      .build(),
  ]);
  const outcomes: string[] = [];
  for (const [route, body, label] of [
    ["fn", { handler: () => 1 }, "body with a function"],
    ["fn", new ReadableStream(), "ReadableStream body"],
    ["cls", new Invoice(100), "class instance body"],
  ] as const) {
    try {
      const r = await app.runtime.deliver(route, body);
      outcomes.push(
        `${label}: ${r.status} ${JSON.stringify(r.exchanges[0]?.body)}`,
      );
    } catch (e) {
      outcomes.push(`${label}: ${message(e)}`);
    }
  }
  say(
    "non-JSON bodies",
    outcomes.every((o) => o.includes("completed")) ? "HOLDS" : "REGRESSION",
    outcomes.join(" | "),
  );
  await app.stop();
}

/**
 * Docs draft section 5: "Install yours and declare that it replaces ours,
 * and ours steps aside." In `host.ts` a displaced provider's `provide` is
 * dropped silently, but its `bind` still runs and acquires whatever it opens.
 */
async function displacedProviderStillBinds() {
  const ours = join(dir, "ours.db"),
    theirs = join(dir, "theirs.db");
  const app = application([
    operations,
    deferral,
    sqlite(ours),
    sqlite(theirs, "acme.store", true),
  ]);
  await app.start([]);
  say(
    "displaced provider",
    existsSync(ours) ? "INFO" : "HOLDS",
    `selected ${app.runtime.dump().providers.find((p) => p.port === "records.atomic@1")?.plugin}; displaced default's database ${existsSync(ours) ? "WAS opened on disk" : "was not opened"}`,
  );
  await app.stop();
}

/**
 * Docs draft section 3: "A handler can refuse the exchange or add to it."
 * `runtime.ts` ignores a refusal at `error` (line 346) and discards the
 * decision at `exit` (line 384).
 */
async function refusalAtExitAndError() {
  const log: string[] = [];
  const handler = (point: Handler["point"]) =>
    infrastructure({
      id: `refuser-${point}`,
      bind: (c) =>
        c.contribute({
          kind: "handler",
          id: `refuse-${point}`,
          point,
          survival: allRuns,
          handle: () => {
            log.push(point);
            return { kind: "refuse", reason: "no" };
          },
        }),
    });
  const app = application([operations, handler("exit"), handler("error")]);
  await app.start([
    app
      .route("ok")
      .from(manual)
      .transform((x) => x)
      .build(),
  ]);
  const r = await app.runtime.deliver("ok", 1);
  say(
    "refuse at exit",
    r.status === "completed" ? "INFO" : "HOLDS",
    `exit handler refused, run reported ${r.status}; handlers consulted: ${log.join(",")}`,
  );
  await app.stop();
}

/**
 * Shipped: resume is `markResumed`, a compare-and-swap OUT of `waiting`
 * taken before the continuation runs. A crash between that and
 * `recordContinuation` leaves residue that `resumedWithoutContinuation`
 * REPORTS and nothing re-runs, because "this residue is a half-run
 * CONTINUATION" (`types.ts`). The lease and `releaseClaims` heal
 * `claimExpiry`, the delivery claim for expiry and denial notifications.
 * Round six adopted the lease for resume, so a half-run continuation is
 * re-executed once the lease elapses.
 */
async function leaseRerunsHalfRunContinuation() {
  const path = join(dir, "lease.db");
  const effects: string[] = [];
  let hang = true;
  const build = () => {
    const app = application([operations, deferral, sqlite(path)]);
    const spec = app
      .route("r")
      .from(manual)
      .defer("approval")
      .step("pay", async (ex) => {
        effects.push("pay");
        if (hang) await new Promise<never>(() => {});
        return { kind: "continue", exchange: ex };
      })
      .build();
    return { app, spec };
  };
  const one = build();
  await one.app.start([one.spec]);
  await one.app.runtime.deliver("r", 1);
  // Process one begins the resume, runs the payment, then "dies" mid-run.
  void one.app.runtime.resume("approval").catch(() => undefined);
  await new Promise((r) => setTimeout(r, 20));
  // A sweeper elsewhere releases the stale claim after the lease.
  const heal = new SqliteRecords(path);
  const released = await durableStore(heal).releaseClaims(Date.now() + 1);
  heal.close();
  hang = false;
  const two = build();
  await two.app.start([two.spec]);
  let second: string;
  try {
    second = (await two.app.runtime.resume("approval")).status;
  } catch (e) {
    second = message(e);
  }
  await two.app.stop();
  say(
    "lease re-runs continuation",
    effects.length > 1 ? "REGRESSION" : "HOLDS",
    `released ${released}; second process resume: ${second}; "pay" executed ${effects.length} times (shipped reports the residue and re-runs nothing)`,
  );
}

/**
 * Shipped: `stop()` drains for at most `shutdown.timeout` (default 30s) and
 * then forces stage two (`context.ts` `SHUTDOWN_DEADLINE`, `forceStageTwo`).
 * The spike's `Runtime.stop` awaits every owned promise with no bound.
 */
async function unboundedDrain() {
  const app = application([operations]);
  await app.start([
    app
      .route("hang")
      .from(manual)
      .step("never", () => new Promise<never>(() => {}))
      .build(),
  ]);
  void app.runtime.deliver("hang", 1).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 10));
  const stopped = await Promise.race([
    app.stop().then(() => "stopped"),
    new Promise<string>((r) =>
      setTimeout(() => r("still draining after 500ms"), 500),
    ),
  ]);
  say(
    "bounded shutdown",
    stopped === "stopped" ? "HOLDS" : "REGRESSION",
    `${stopped} (shipped forces after shutdown.timeout, default 30s)`,
  );
}

/**
 * `runtime.ts` re-sorts every contribution on every handler point of every
 * exchange (`handlers()` calls `host.ordered(host.contributions)`), rather
 * than once at freeze as DIAGRAMS-MECHANISM.md section 3 draws it.
 */
async function handlerOrderingCost() {
  const plugins = Array.from({ length: 30 }, (_, i) =>
    infrastructure({
      id: `p${String(i).padStart(2, "0")}`,
      bind: (c) =>
        c.contribute({
          kind: "handler",
          // Contribution ids are one flat namespace across every plugin
          // (host.ts line 198), so a shared name like "h" fails at boot.
          id: `h${i}`,
          point: "entry",
          survival: allRuns,
          handle: (ex) => ({ kind: "allow", exchange: ex }),
        }),
    }),
  );
  const app = application([operations, ...plugins] as const);
  await app.start([
    app
      .route("r")
      .from(manual)
      .transform((x) => x)
      .build(),
  ]);
  const started = performance.now();
  for (let i = 0; i < 200; i++) await app.runtime.deliver("r", i);
  const perExchange = (performance.now() - started) / 200;
  say(
    "handler sort per exchange",
    "INFO",
    `30 handlers, 200 exchanges: ${perExchange.toFixed(2)} ms per exchange through four handler points`,
  );
  await app.stop();
}

const probes = [
  perRouteDeferralId,
  planHashScope,
  duplicateResume,
  principalForgery,
  nonCloneableBodies,
  displacedProviderStillBinds,
  refusalAtExitAndError,
  unboundedDrain,
  handlerOrderingCost,
  leaseRerunsHalfRunContinuation,
];
try {
  for (const probe of probes) {
    try {
      await probe();
    } catch (e) {
      say(probe.name, "PROBE-ERROR", message(e));
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
  // The lease and drain probes deliberately leave work hanging.
  process.exit(0);
}
