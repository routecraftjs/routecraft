import { afterEach, describe, expect, test } from "bun:test";
import { cacheProviderConformance } from "@routecraft/testing";
import { MemoryCacheProvider, type CacheProvider } from "../src/index.ts";

/**
 * A store written against the interface alone, the way a third party
 * writes one: a map, an expiry per entry and one in-flight load per key.
 */
function mapStore(): CacheProvider {
  const entries = new Map<string, { value: unknown; expires?: number }>();
  const loading = new Map<string, Promise<unknown>>();
  const live = (key: string) => {
    const entry = entries.get(key);
    if (entry?.expires !== undefined && entry.expires <= Date.now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };
  const store: CacheProvider = {
    get: async (key) => live(key)?.value,
    has: async (key) => live(key) !== undefined,
    delete: async (key) => {
      entries.delete(key);
    },
    set: async (key, value, ttl) => {
      if (value === undefined) throw new Error("undefined is not storable");
      entries.set(key, {
        value,
        ...(ttl !== undefined ? { expires: Date.now() + ttl } : {}),
      });
    },
    getOrCompute: async <T>(
      key: string,
      loader: () => Promise<T>,
      ttl?: number,
    ): Promise<T> => {
      const entry = live(key);
      if (entry) return entry.value as T;
      let pending = loading.get(key) as Promise<T> | undefined;
      if (!pending) {
        pending = loader()
          .then(async (value) => {
            if (value !== undefined) await store.set(key, value, ttl);
            return value;
          })
          .finally(() => loading.delete(key));
        loading.set(key, pending);
      }
      return pending;
    },
  };
  return store;
}

const runner = { describe, test, afterEach, expect };

cacheProviderConformance("memory", () => new MemoryCacheProvider(), runner);
cacheProviderConformance("a third party's map store", mapStore, runner);
