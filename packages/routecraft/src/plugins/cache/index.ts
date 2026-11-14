import { definePlugin } from "../../kernel/plugin.ts";
import { registerShippedPlugin } from "../../kernel/defaults.ts";
import { CACHE_STORE } from "../../kernel/positions.ts";
import { MemoryCacheProvider } from "../../operations/cache-provider.ts";

/**
 * The plugin that provides {@link CACHE_STORE}, installed by default: one
 * in-memory store per application. A plugin that keeps entries elsewhere
 * provides and replaces the port with its own `CacheProvider`; the cache's
 * policy stays the kernel's either way.
 */
export function cachePlugin() {
  return definePlugin({
    id: "routecraft.cache",
    provides: [CACHE_STORE],
    bind(c) {
      c.provide(CACHE_STORE, new MemoryCacheProvider());
    },
  });
}

registerShippedPlugin(cachePlugin, { default: true });
