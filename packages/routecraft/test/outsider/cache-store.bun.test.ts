import { afterEach, describe, expect, test } from "bun:test";
import {
  CACHE_STORE,
  MemoryCacheProvider,
  craft,
  definePlugin,
  direct,
  type CacheProvider,
  type Exchange,
  type RouteBuilder,
} from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";

const OPERATION = "routecraft.cache.discriminator";

interface Call {
  readonly tool: string;
}

/** A store that keeps entries in memory and records every key written. */
function recordingStore(): CacheProvider & { readonly written: string[] } {
  const inner = new MemoryCacheProvider();
  const written: string[] = [];
  return {
    written,
    get: (key) => inner.get(key),
    has: (key) => inner.has(key),
    delete: (key) => inner.delete(key),
    async set(key, value, ttl) {
      written.push(key);
      await inner.set(key, value, ttl);
    },
    getOrCompute(key, loader, ttl) {
      return inner.getOrCompute(
        key,
        async () => {
          const value = await loader();
          if (value !== undefined) written.push(key);
          return value;
        },
        ttl,
      );
    },
  };
}

function storePlugin(store: CacheProvider) {
  return definePlugin({
    id: "acme.cache-store",
    provides: [CACHE_STORE],
    replaces: [CACHE_STORE],
    bind(c) {
      c.provide(CACHE_STORE, store);
    },
  });
}

const isRead = (exchange: Exchange): boolean =>
  exchange.headers[OPERATION] !== "write";

/**
 * A third party replaces where the cache keeps its entries and nothing
 * else. What is cached, under which key, and when the cache steps aside
 * stay the kernel's, so a store cannot get them wrong.
 */
describe("outsider: a cache store built on the published entry", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop();
    t = undefined;
  });

  const proxies: Record<string, (runs: string[]) => RouteBuilder> = {
    route: (runs) =>
      craft()
        .id("proxy")
        .cache({ when: isRead })
        .from(direct<Call>())
        .transform((body, exchange) => {
          runs.push(String(exchange.headers[OPERATION]));
          return `${String(exchange.headers[OPERATION])}:${body.tool}`;
        }),
    step: (runs) =>
      craft()
        .id("proxy")
        .from(direct<Call>())
        .cache({ when: isRead })
        .transform((body, exchange) => {
          runs.push(String(exchange.headers[OPERATION]));
          return `${String(exchange.headers[OPERATION])}:${body.tool}`;
        }),
  };

  for (const [scope, proxy] of Object.entries(proxies)) {
    /**
     * @case A replaced store behind a proxy-like route that caches reads only
     * @preconditions A plugin replacing CACHE_STORE with a recording store; a route with .cache({ when: isRead }); equal bodies sent as a read, a list and a write, the read twice
     * @expectedResult The write runs every time and never reaches the store; the read and the list are stored under two keys; the second read is served without running the route
     */
    test(`${scope} scope: the kernel decides what reaches the store`, async () => {
      const store = recordingStore();
      const runs: string[] = [];
      t = await testContext()
        .with({ plugins: [storePlugin(store)] })
        .routes([proxy(runs)])
        .build();
      await t.startAndWaitReady();
      const call = (operation: string) =>
        t!.client.sendDirect<Call, string>(
          "proxy",
          { tool: "accounts" },
          { [OPERATION]: operation },
        );

      expect(await call("read")).toBe("read:accounts");
      expect(await call("read")).toBe("read:accounts");
      expect(await call("list")).toBe("list:accounts");
      expect(await call("write")).toBe("write:accounts");
      expect(await call("write")).toBe("write:accounts");

      expect(runs).toEqual(["read", "list", "write", "write"]);
      expect(store.written).toHaveLength(2);
      expect(new Set(store.written).size).toBe(2);
    });

    /**
     * @case A cache that names its own provider beside a replaced store
     * @preconditions A plugin replacing CACHE_STORE with a recording store; a route whose .cache({ provider }) names another
     * @expectedResult The entry lands in the named provider and the application's store sees nothing
     */
    test(`${scope} scope: a per-call provider wins over the store`, async () => {
      const store = recordingStore();
      const own = recordingStore();
      const route =
        scope === "route"
          ? craft()
              .id("own")
              .cache({ provider: own })
              .from(direct<Call>())
              .transform((body) => body.tool)
          : craft()
              .id("own")
              .from(direct<Call>())
              .cache({ provider: own })
              .transform((body) => body.tool);
      t = await testContext()
        .with({ plugins: [storePlugin(store)] })
        .routes([route])
        .build();
      await t.startAndWaitReady();

      await t.client.sendDirect("own", { tool: "accounts" });

      expect(own.written).toHaveLength(1);
      expect(store.written).toEqual([]);
    });
  }
});
