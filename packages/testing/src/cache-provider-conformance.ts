import type { CacheProvider } from "@routecraft/routecraft";
import type { ConformanceRunner } from "./deferral-store-conformance";

/**
 * The contract every `CacheProvider` meets, as a suite a backend runs
 * against itself. The shipped `MemoryCacheProvider` runs it, so a store
 * that passes can be passed to `.cache({ provider })` or provided on the
 * `CACHE_STORE` port in its place: an entry comes back only under the key
 * it was stored under, `undefined` is a miss and never a value, and
 * `getOrCompute` runs one loader per key however many callers ask at once.
 *
 * Run it from a test file. It registers its cases with the runner it is
 * given and opens a fresh store for each.
 *
 * @param name - Names the backend in the suite title
 * @param open - Opens an empty store
 * @param runner - The test runner's `describe`, `test`, `afterEach` and `expect`
 *
 * @example
 * ```ts
 * import { afterEach, describe, expect, test } from "bun:test";
 * import { cacheProviderConformance } from "@routecraft/testing";
 *
 * cacheProviderConformance("redis", () => redisCache(), {
 *   describe,
 *   test,
 *   afterEach,
 *   expect,
 * });
 * ```
 */
export function cacheProviderConformance(
  name: string,
  open: () => CacheProvider | Promise<CacheProvider>,
  runner: ConformanceRunner,
): void {
  const { describe, test, expect } = runner;

  describe(`CacheProvider conformance: ${name}`, () => {
    /**
     * @case A key nothing was stored under
     * @preconditions An empty store
     * @expectedResult `get` resolves undefined and `has` resolves false
     */
    test("a missing key is a miss", async () => {
      const store = await open();
      expect(await store.get("absent")).toBeUndefined();
      expect(await store.has("absent")).toBe(false);
    });

    /**
     * @case A stored value is read back under its own key only
     * @preconditions Two values stored under two keys
     * @expectedResult Each key returns its own value, and a third key misses
     */
    test("an entry is returned only under its key", async () => {
      const store = await open();
      await store.set("a", { n: 1 });
      await store.set("b", { n: 2 });
      expect(await store.get("a")).toEqual({ n: 1 });
      expect(await store.get("b")).toEqual({ n: 2 });
      expect(await store.has("a")).toBe(true);
      expect(await store.get("ab")).toBeUndefined();
    });

    /**
     * @case null is a value, distinct from a miss
     * @preconditions null stored under a key
     * @expectedResult `get` resolves null, `has` resolves true, and `getOrCompute` does not run its loader
     */
    test("null is stored and is not a miss", async () => {
      const store = await open();
      await store.set("k", null);
      expect(await store.get("k")).toBe(null);
      expect(await store.has("k")).toBe(true);
      let ran = 0;
      const value = await store.getOrCompute("k", async () => {
        ran++;
        return "loaded";
      });
      expect(value).toBe(null);
      expect(ran).toBe(0);
    });

    /**
     * @case undefined cannot be stored
     * @preconditions `set` called with undefined
     * @expectedResult The call rejects and the key stays a miss
     */
    test("set refuses undefined", async () => {
      const store = await open();
      await expect(store.set("k", undefined)).rejects.toThrow();
      expect(await store.has("k")).toBe(false);
    });

    /**
     * @case Deleting an entry, and a key that was never stored
     * @preconditions One stored entry
     * @expectedResult The entry is gone afterwards, and deleting an absent key resolves
     */
    test("delete removes an entry and ignores an absent key", async () => {
      const store = await open();
      await store.set("k", 1);
      await store.delete("k");
      expect(await store.get("k")).toBeUndefined();
      await store.delete("never");
    });

    /**
     * @case An entry stored with a ttl expires
     * @preconditions A value stored with a 20 ms ttl
     * @expectedResult It is readable at once and a miss after the ttl has passed
     */
    test("an entry expires after its ttl", async () => {
      const store = await open();
      await store.set("k", "v", 20);
      expect(await store.get("k")).toBe("v");
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(await store.get("k")).toBeUndefined();
      expect(await store.has("k")).toBe(false);
    });

    /**
     * @case getOrCompute loads on a miss and serves the entry on a hit
     * @preconditions An empty store, asked twice for one key
     * @expectedResult The loader runs once, both calls resolve its value, and `get` reads the entry
     */
    test("getOrCompute loads once and then hits", async () => {
      const store = await open();
      let ran = 0;
      const loader = async () => ({ run: ++ran });
      expect(await store.getOrCompute("k", loader)).toEqual({ run: 1 });
      expect(await store.getOrCompute("k", loader)).toEqual({ run: 1 });
      expect(await store.get("k")).toEqual({ run: 1 });
      expect(ran).toBe(1);
    });

    /**
     * @case Concurrent callers of one key share one loader run
     * @preconditions Five getOrCompute calls on one key and one on another, all started before the loader settles
     * @expectedResult The contended key's loader runs once and all five callers get its value; the other key runs its own
     */
    test("getOrCompute runs one loader per key under contention", async () => {
      const store = await open();
      const runs: Record<string, number> = {};
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const load = (key: string) => async () => {
        runs[key] = (runs[key] ?? 0) + 1;
        await gate;
        return `value of ${key}`;
      };
      const contended = Array.from({ length: 5 }, () =>
        store.getOrCompute("a", load("a")),
      );
      const other = store.getOrCompute("b", load("b"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      release();
      expect(await Promise.all(contended)).toEqual(
        Array.from({ length: 5 }, () => "value of a"),
      );
      expect(await other).toBe("value of b");
      expect(runs).toEqual({ a: 1, b: 1 });
    });

    /**
     * @case A loader that throws
     * @preconditions getOrCompute with a rejecting loader, then with a working one
     * @expectedResult The first call rejects with the loader's error and caches nothing, so the second runs its loader
     */
    test("a failed loader propagates and caches nothing", async () => {
      const store = await open();
      await expect(
        store.getOrCompute("k", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await store.has("k")).toBe(false);
      expect(await store.getOrCompute("k", async () => "ok")).toBe("ok");
    });

    /**
     * @case A loader that resolves undefined
     * @preconditions getOrCompute whose loader resolves undefined, called twice
     * @expectedResult Both calls resolve undefined without throwing, and nothing is stored, so the loader runs each time
     */
    test("an undefined result is returned and not stored", async () => {
      const store = await open();
      let ran = 0;
      const loader = async () => {
        ran++;
        return undefined;
      };
      expect(await store.getOrCompute("k", loader)).toBeUndefined();
      expect(await store.getOrCompute("k", loader)).toBeUndefined();
      expect(await store.has("k")).toBe(false);
      expect(ran).toBe(2);
    });
  });
}
