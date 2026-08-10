import { describe, expect, test } from "bun:test";
import { createConnectionCache } from "../src/mcp/http-client-cache.ts";

/** A cached entry that records whether it was disposed. */
function entry(): { disposed: number; dispose(): Promise<void> } {
  const e = {
    disposed: 0,
    dispose: async (): Promise<void> => {
      e.disposed += 1;
    },
  };
  return e;
}

/** A deferred whose resolution the test controls. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createConnectionCache", () => {
  /**
   * @case Two callers request the same key while the first connection is still in flight
   * @preconditions `create` returns a deferred that has not settled when the second caller arrives
   * @expectedResult `create` runs once and both callers receive the same entry. Caching the resolved value instead of the promise would let both callers miss, connect twice, and leave the displaced connection unreachable and never disposed
   */
  test("joins concurrent callers onto one in-flight connection", async () => {
    const cache = createConnectionCache<ReturnType<typeof entry>>();
    const gate = deferred<ReturnType<typeof entry>>();
    let creates = 0;

    const create = (): Promise<ReturnType<typeof entry>> => {
      creates += 1;
      return gate.promise;
    };

    const first = cache.getOrCreate("srv", create);
    const second = cache.getOrCreate("srv", create);

    const only = entry();
    gate.resolve(only);

    expect(await first).toBe(only);
    expect(await second).toBe(only);
    expect(creates).toBe(1);
  });

  /**
   * @case Every cached connection is disposed exactly once on teardown
   * @preconditions Two keys cached, each resolved
   * @expectedResult Both entries disposed once and the cache is emptied, so a second teardown disposes nothing again
   */
  test("disposes each entry once and empties the cache", async () => {
    const cache = createConnectionCache<ReturnType<typeof entry>>();
    const a = entry();
    const b = entry();
    await cache.getOrCreate("a", async () => a);
    await cache.getOrCreate("b", async () => b);

    await cache.disposeAll(() => {
      throw new Error("unexpected dispose failure");
    });

    expect(a.disposed).toBe(1);
    expect(b.disposed).toBe(1);

    await cache.disposeAll(() => undefined);
    expect(a.disposed).toBe(1);
  });

  /**
   * @case A failed connection attempt does not poison the key
   * @preconditions First `create` rejects; a later call supplies a working one
   * @expectedResult The rejection is delivered to the first caller, and the retry connects instead of replaying the cached rejection
   */
  test("evicts a rejected attempt so the key can retry", async () => {
    const cache = createConnectionCache<ReturnType<typeof entry>>();
    const boom = new Error("connect failed");

    await expect(
      cache.getOrCreate("srv", () => Promise.reject(boom)),
    ).rejects.toBe(boom);

    const good = entry();
    expect(await cache.getOrCreate("srv", async () => good)).toBe(good);
  });

  /**
   * @case A failing refresh must not evict the healthy connection a concurrent refresh cached
   * @preconditions Entry A is cached then evicted by its own caller; entry B is cached under the same key before the stale caller evicts
   * @expectedResult Only the entry the caller actually used is disposed, and the newer entry stays cached
   */
  test("evicts only the entry the caller used", async () => {
    const cache = createConnectionCache<ReturnType<typeof entry>>();
    const stale = entry();
    const fresh = entry();

    const stalePending = cache.getOrCreate("srv", async () => stale);
    await stalePending;

    await cache.evict("srv", stalePending);
    expect(stale.disposed).toBe(1);

    const freshPending = cache.getOrCreate("srv", async () => fresh);
    await freshPending;

    // The stale caller retries its eviction after the fresh entry landed.
    await cache.evict("srv", stalePending);
    expect(fresh.disposed).toBe(0);
    expect(await cache.getOrCreate("srv", async () => entry())).toBe(fresh);
  });
});
