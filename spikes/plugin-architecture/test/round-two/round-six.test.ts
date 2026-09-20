import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Application,
  infrastructure,
  instruction,
  continueWith,
  allRuns,
  deferral,
  sqlite,
  SqliteRecords,
  durableStore,
  type Continuation,
  type Step,
  type RouteSpec,
  type Handler,
} from "../../src/v2/index.ts";

/**
 * Round-six additions.
 *
 * Each test here closes a gap round five left open, found by mutating the
 * implementation and observing that the round-five suite still passed. The
 * claim-lease tests also close a contract gap against the shipped framework,
 * whose `DeferralStore` treats a claim as a second axis over a waiting record
 * precisely so a dead claimant can be healed by `releaseClaims`.
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
  const dir = mkdtempSync(join(tmpdir(), "routecraft-survival-"));
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
                request: { id: "approval", reason: "wait" },
              },
        ),
      ],
      options: {},
    };
    await app.start([spec]);
    expect((await app.runtime.deliver("r", 1)).status).toBe("deferred");
    expect(log).toEqual(["every-run:r", "normal-only:r"]);
    expect((await app.runtime.resume("approval")).status).toBe("completed");
    await app.stop();
    expect(log).toEqual(["every-run:r", "normal-only:r", "every-run:r"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const sample: Continuation = {
  codec: 1,
  routeId: "r",
  plan: "hash",
  pending: [],
  exchange: {
    id: "e",
    routeId: "r",
    body: 1,
    headers: {},
    principal: { subject: "alice", grants: [], lent: [] },
  },
};

/**
 * @case claim holder dies
 * @preconditions a continuation is claimed and the process ends before finish
 * @expectedResult the record stays discoverable and is resumable again once the lease elapses */
test("a continuation claimed by a process that dies is released by the lease, not stranded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "routecraft-lease-"));
  try {
    const first = new SqliteRecords(join(dir, "d.db"));
    const before = durableStore(first);
    await before.save("approval", sample);
    expect(await before.claim("approval", 1_000)).toBeTruthy();
    expect(await before.claim("approval", 1_001)).toBeUndefined();
    first.close();

    const second = new SqliteRecords(join(dir, "d.db"));
    const after = durableStore(second);
    expect(await second.keys("waiting/")).toEqual(["waiting/approval"]);
    expect(await after.claim("approval", 1_002)).toBeUndefined();
    expect(await after.releaseClaims(1_000 + 60 * 60 * 1_000)).toBe(1);
    expect(await after.claim("approval", 2_000)).toBeTruthy();
    await after.finish("approval", "completed");
    expect(await second.keys("waiting/")).toEqual([]);
    expect(await after.claim("approval", 3_000)).toBeUndefined();
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * @case lease not yet elapsed
 * @preconditions a live claim younger than the lease
 * @expectedResult the sweep releases nothing and the claim stays exclusive */
test("releaseClaims honours the lease and leaves a live claim alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "routecraft-lease-live-"));
  try {
    const records = new SqliteRecords(join(dir, "d.db"));
    const store = durableStore(records);
    await store.save("approval", sample);
    expect(await store.claim("approval", 5_000)).toBeTruthy();
    expect(await store.releaseClaims(4_999)).toBe(0);
    expect(await store.claim("approval", 6_000)).toBeUndefined();
    await store.finish("approval", "completed");
    expect(await store.releaseClaims(9e9)).toBe(0);
    records.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
