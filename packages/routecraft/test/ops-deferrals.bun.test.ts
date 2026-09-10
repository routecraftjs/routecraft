import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { bootServer, type TestContext } from "@routecraft/testing";
import {
  MemoryDeferralStore,
  craft,
  direct,
  noop,
  opsPlugin,
  type CraftConfig,
  type DeferralStore,
  type NewDeferral,
  type OpsDeferralSummary,
  type OpsPage,
} from "../src/index.ts";

/**
 * `GET /ops/deferrals`: what an instance is waiting on, without invoking
 * anything.
 *
 * The record already carried every field a listing renders. What was
 * missing was the surface, so a deferral could only be seen as the
 * outcome of the call that produced it. The cases here are the ones a
 * reader depends on: oldest first, paged, filterable, and carrying the
 * reason it waits without carrying the payload it waits on.
 */

const SECRET = "ops-deferrals-secret-0123456789-abc";

const Approval = z.object({ approved: z.boolean() });

describe("the deferrals management resource", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * An instance with the introspection tier open and one route that
   * defers, returning where to read it and how to make it defer again.
   */
  async function boot(store?: Omit<DeferralStore, "list">): Promise<{
    base: string;
    defer: (amountCents: number) => Promise<void>;
  }> {
    const booted = await bootServer((builder) =>
      builder
        .with({
          servers: { default: { port: 0, host: "127.0.0.1" } },
          deferral: {
            secret: SECRET,
            // Cast because the case under test is precisely a store that
            // does not satisfy the current contract; every caller in
            // production is type-checked against it.
            ...(store !== undefined ? { store: store as DeferralStore } : {}),
          },
          plugins: [
            opsPlugin({ tiers: { introspection: true, dispatch: true } }),
          ],
        } as CraftConfig)
        .routes([
          craft()
            .id("payout")
            .from(direct())
            .defer({ schema: Approval, ttl: "72h" })
            .transform(() => ({ paid: true }))
            .to(noop()),
          craft()
            .id("refund")
            .from(direct())
            .defer({ schema: Approval, ttl: "72h" })
            .transform(() => ({ refunded: true }))
            .to(noop()),
        ]),
    );
    t = booted.ctx;
    return {
      base: `http://127.0.0.1:${String(booted.port)}`,
      defer: async (amountCents) => {
        await t!.client.sendDirect("payout", { amountCents });
      },
    };
  }

  /** Read a page off the listing. */
  async function page(
    base: string,
    query = "",
  ): Promise<OpsPage<OpsDeferralSummary>> {
    const response = await fetch(`${base}/ops/deferrals${query}`);
    return (await response.json()) as OpsPage<OpsDeferralSummary>;
  }

  /**
   * @case A deferred exchange appears in the listing
   * @preconditions One dispatch to a route that defers, on an instance with the introspection tier open
   * @expectedResult One row naming the route, the state, what it waits for and when it comes due. This is the criterion #736 could not meet by renaming: the record carried the reason and nothing rendered it
   */
  test("lists what is waiting", async () => {
    const { base, defer } = await boot();
    await defer(90_000);

    const { items } = await page(base);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      routeId: "payout",
      state: "waiting",
      waitingFor: "resume",
      claimed: false,
    });
    expect(Date.parse(items[0]!.deferredAt)).toBeGreaterThan(0);
    expect(Date.parse(items[0]!.expiresAt!)).toBeGreaterThan(0);
  });

  /**
   * @case The listing never carries the payload or the credential
   * @preconditions A deferral whose exchange body carries a value nobody reading a listing may see
   * @expectedResult The row has no exchange, no resume token, no schema and no step state, and the body's value appears nowhere in the response. A management listing is read by whoever holds the introspection scope, which is not the same person as the approver
   */
  test("never renders the exchange or the token", async () => {
    const { base, defer } = await boot();
    await defer(1_234_567);

    const response = await fetch(`${base}/ops/deferrals`);
    const raw = await response.text();

    expect(raw).not.toContain("1234567");
    const { items } = JSON.parse(raw) as OpsPage<OpsDeferralSummary>;
    expect(Object.keys(items[0]!).sort()).toEqual([
      "claimed",
      "deferredAt",
      "expiresAt",
      "id",
      "routeId",
      "state",
      "waitingFor",
    ]);
  });

  /**
   * @case The listing pages oldest first and the cursor advances
   * @preconditions Three deferrals, read two at a time
   * @expectedResult The first page carries a cursor and the second the rest, with no row repeated. An instance that has deferred a hundred thousand exchanges must not answer with all of them
   */
  test("pages oldest first", async () => {
    const { base, defer } = await boot();
    for (const amount of [1, 2, 3]) await defer(amount);

    const first = await page(base, "?limit=2");
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();

    const second = await page(
      base,
      `?limit=2&after=${encodeURIComponent(first.nextCursor!)}`,
    );

    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    const ids = [...first.items, ...second.items].map((row) => row.id);
    expect(new Set(ids).size).toBe(3);
  });

  /**
   * @case A cursor is bound to the filter that minted it
   * @preconditions A cursor from an unfiltered listing, replayed with a route filter
   * @expectedResult RC5059 as a 400. A cursor pages one result set, so replaying it under another filter would hand back a page of a different set with no way for the caller to notice
   */
  test("refuses a cursor replayed under another filter", async () => {
    const { base, defer } = await boot();
    for (const amount of [1, 2]) await defer(amount);
    const first = await page(base, "?limit=1");

    const response = await fetch(
      `${base}/ops/deferrals?limit=1&route=payout&after=${encodeURIComponent(first.nextCursor!)}`,
    );

    expect(response.status).toBe(400);
  });

  /**
   * @case Waiting is the default and the other states are asked for
   * @preconditions One waiting deferral and one settled by a resume, on two different routes
   * @expectedResult The bare listing shows the waiting one, `state=settled` the settled one with its outcome, `state=all` both, and `route=` narrows to one route. The question this surface is opened with is what is still owed an answer
   */
  test("filters by state and by route", async () => {
    const store = new MemoryDeferralStore();
    const { base, defer } = await boot(store);
    await defer(1);
    const waiting = (await store.list({ limit: 10 }))[0]!;
    await store.markResumed(waiting.id, { at: new Date() });
    await defer(2);

    const bare = await page(base);
    const settled = await page(base, "?state=settled");
    const all = await page(base, "?state=all");
    const byRoute = await page(base, "?state=all&route=refund");

    expect(bare.items).toHaveLength(1);
    expect(bare.items[0]!.state).toBe("waiting");
    expect(settled.items).toHaveLength(1);
    expect(settled.items[0]!.outcome).toMatchObject({ kind: "resumed" });
    expect(all.items).toHaveLength(2);
    expect(byRoute.items).toEqual([]);
  });

  /**
   * @case A state nobody defined is refused rather than ignored
   * @preconditions A `state` the vocabulary does not carry
   * @expectedResult 400. Ignoring it would answer the default listing to a caller who asked for something else and read the answer as theirs
   */
  test("refuses a state outside the vocabulary", async () => {
    const { base } = await boot();

    const response = await fetch(`${base}/ops/deferrals?state=pending`);

    expect(response.status).toBe(400);
  });

  /**
   * @case One deferral is addressable by id
   * @preconditions A deferral, read at `/ops/deferrals/{id}`
   * @expectedResult The same summary the listing carries, and 404 for an id nothing holds
   */
  test("describes one deferral by id", async () => {
    const store = new MemoryDeferralStore();
    const { base, defer } = await boot(store);
    await defer(1);
    const [row] = await store.list({ limit: 1 });

    const found = await fetch(
      `${base}/ops/deferrals/${encodeURIComponent(row!.id)}`,
    );
    const missing = await fetch(`${base}/ops/deferrals/nothing-by-that-id`);

    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({
      id: row!.id,
      routeId: "payout",
      state: "waiting",
    });
    expect(missing.status).toBe(404);
  });

  /**
   * @case A store that cannot list says so rather than answering empty
   * @preconditions A custom DeferralStore written against a contract without `list`
   * @expectedResult The mount answers 500 carrying RC5065, which names the missing member. An empty page and a page the store cannot produce look identical to whoever is reading it, and one of them is a lie
   */
  test("refuses when the configured store cannot list", async () => {
    const { base } = await boot(new StoreWithoutList());

    const response = await fetch(`${base}/ops/deferrals`);

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "RC5065" });
  });

  /**
   * @case A context with no deferral runtime has no listing at all
   * @preconditions An instance with the ops tier open and no `deferral` config
   * @expectedResult 404. The resource is registered by the deferral plugin, so an instance that never configured deferral offers no surface rather than an empty one that reads as "nothing is waiting"
   */
  test("is absent when the context configured no deferral", async () => {
    const booted = await bootServer((builder) =>
      builder
        .with({
          servers: { default: { port: 0, host: "127.0.0.1" } },
          plugins: [opsPlugin({ tiers: { introspection: true } })],
        })
        .routes([craft().id("greet").from(direct()).to(noop())]),
    );
    t = booted.ctx;

    const response = await fetch(
      `http://127.0.0.1:${String(booted.port)}/ops/deferrals`,
    );

    expect(response.status).toBe(404);
  });
});

/**
 * A consumer's own backend, written against the contract as it stood
 * before the listing existed.
 *
 * Delegation to a real store rather than a `Proxy` over one: a proxy that
 * hides a member also breaks the private-field access every other method
 * makes, so the store fails at boot instead of at the listing, which is
 * not the case under test.
 */
class StoreWithoutList implements Omit<DeferralStore, "list"> {
  readonly #inner = new MemoryDeferralStore();

  create = (...args: Parameters<DeferralStore["create"]>) =>
    this.#inner.create(...args);
  get = (...args: Parameters<DeferralStore["get"]>) => this.#inner.get(...args);
  markResumed = (...args: Parameters<DeferralStore["markResumed"]>) =>
    this.#inner.markResumed(...args);
  claimExpiry = (...args: Parameters<DeferralStore["claimExpiry"]>) =>
    this.#inner.claimExpiry(...args);
  markExpired = (...args: Parameters<DeferralStore["markExpired"]>) =>
    this.#inner.markExpired(...args);
  markDenied = (...args: Parameters<DeferralStore["markDenied"]>) =>
    this.#inner.markDenied(...args);
  releaseClaims = (...args: Parameters<DeferralStore["releaseClaims"]>) =>
    this.#inner.releaseClaims(...args);
  replaceStepState = (...args: Parameters<DeferralStore["replaceStepState"]>) =>
    this.#inner.replaceStepState(...args);
  recordContinuation = (
    ...args: Parameters<DeferralStore["recordContinuation"]>
  ) => this.#inner.recordContinuation(...args);
  findExpired = (...args: Parameters<DeferralStore["findExpired"]>) =>
    this.#inner.findExpired(...args);
  pending = () => this.#inner.pending();
  resumedWithoutContinuation = (
    ...args: Parameters<DeferralStore["resumedWithoutContinuation"]>
  ) => this.#inner.resumedWithoutContinuation(...args);
  purgeSettled = (...args: Parameters<DeferralStore["purgeSettled"]>) =>
    this.#inner.purgeSettled(...args);
  close = () => this.#inner.close();
}

/**
 * The listing reads a real store, so a record shaped by hand is not a
 * substitute. This keeps the one thing a hand-built record proves: the
 * projection drops what it must, whatever the backend.
 */
describe("the deferral summary projection", () => {
  /**
   * @case Every slot a listing may not show is dropped
   * @preconditions A record carrying an exchange, a schema, meta, a step state, a call binding and a continuation hash
   * @expectedResult None of them survive into the summary. The projection is where the exchange stops, named once so a field cannot reach the listing from one backend and not the other
   */
  test("carries no payload-bearing slot", async () => {
    const store = new MemoryDeferralStore();
    const full: NewDeferral = {
      id: "d-1",
      routeId: "payout",
      position: 3,
      continuationHash: "c".repeat(64),
      actionFingerprint: "f".repeat(64),
      exchange: {
        body: { secretAmount: 4242 },
        headers: { "routecraft.id": "ex-1" },
      },
      schema: { hash: "e".repeat(64) },
      meta: { reviewers: ["alice"] },
      callBinding: "call-1",
      stepState: { thread: ["private"] },
      waitingFor: "resume",
      deferredAt: new Date("2026-08-10T09:00:00.000Z"),
    };
    await store.create(full);

    const [summary] = await store.list({ limit: 1 });

    expect(JSON.stringify(summary)).not.toContain("4242");
    expect(JSON.stringify(summary)).not.toContain("private");
    expect(JSON.stringify(summary)).not.toContain("alice");
    expect(Object.keys(summary!).sort()).toEqual([
      "claimed",
      "deferredAt",
      "id",
      "routeId",
      "state",
      "waitingFor",
    ]);
  });
});
