import { definePlugin } from "../../kernel/plugin.ts";
import { registerShippedPlugin } from "../../kernel/defaults.ts";
import { CACHE, type CachePositions } from "../../kernel/positions.ts";
import {
  buildCacheCheckStep,
  buildCacheStoreStep,
} from "../../pipeline/synthetic-steps.ts";
import {
  bindCacheProvider,
  cacheStepRun,
} from "../../operations/cache-wrapper.ts";
import {
  MemoryCacheProvider,
  type CacheProvider,
} from "../../operations/cache-provider.ts";

/**
 * The framework's cache positions over `fallback`, the provider a `.cache()`
 * that supplies none of its own runs against: what fills `cacheCheck`,
 * `cacheStore` and the step-scope wrap unless an installed plugin replaces
 * {@link CACHE}. A plugin wrapping the default builds its own with the
 * fallback it wants.
 *
 * @param fallback - The provider for call sites without one; a fresh
 *   in-memory provider by default
 */
export function cacheProvider(
  fallback: CacheProvider = new MemoryCacheProvider(),
): CachePositions {
  return {
    check: (options) =>
      buildCacheCheckStep(bindCacheProvider(options, fallback)),
    store: (options) =>
      buildCacheStoreStep(bindCacheProvider(options, fallback)),
    wrap: (options) => cacheStepRun(bindCacheProvider(options, fallback)),
  };
}

/** The plugin that provides {@link CACHE}, installed by default. */
export function cachePlugin() {
  return definePlugin({
    id: "routecraft.cache",
    provides: [CACHE],
    bind(c) {
      // One store per application: two applications in a process that run
      // one route id over one body never serve each other's entries.
      c.provide(CACHE, cacheProvider());
    },
  });
}

registerShippedPlugin(cachePlugin, { default: true });
