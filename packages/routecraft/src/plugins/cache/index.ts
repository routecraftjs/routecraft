import { definePlugin } from "../../kernel/plugin.ts";
import { registerDefaultPlugin } from "../../kernel/defaults.ts";
import { CACHE, type CachePositions } from "../../kernel/positions.ts";
import {
  buildCacheCheckStep,
  buildCacheStoreStep,
} from "../../pipeline/synthetic-steps.ts";

/**
 * The framework's cache positions: what fills `cacheCheck` and `cacheStore`
 * unless an installed plugin replaces {@link CACHE}.
 */
export const cacheProvider: CachePositions = {
  check: (options) => buildCacheCheckStep(options),
  store: (options) => buildCacheStoreStep(options),
};

/** The plugin that provides {@link CACHE}, installed by default. */
export function cachePlugin() {
  return definePlugin({
    id: "routecraft.cache",
    provides: [CACHE],
    bind(c) {
      c.provide(CACHE, cacheProvider);
    },
  });
}

registerDefaultPlugin("routecraft.cache", cachePlugin);
