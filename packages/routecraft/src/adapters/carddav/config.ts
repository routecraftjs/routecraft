import { registerConfigApplier } from "../../config-applier.ts";
import { definePlugin } from "../../kernel/plugin.ts";
import { CarddavClientManager } from "./client-manager.ts";
import { CARDDAV } from "./shared.ts";
import type { CarddavContextConfig } from "./types.ts";

declare module "@routecraft/routecraft" {
  interface CraftConfig {
    /** CardDAV adapter configuration with named accounts */
    carddav?: CarddavContextConfig;
  }
}

/**
 * Register the `carddav` config key so `defineConfig({ carddav: {...} })`
 * constructs the shared {@link CarddavClientManager} during `initPlugins()`
 * and drains it during plugin teardown (reverse plugin order, so user
 * plugins tear down first). Loaded as a side-effect import from
 * `packages/routecraft/src/index.ts`. Keeps the core context free of
 * CardDAV adapter knowledge.
 */
registerConfigApplier("carddav", (options) =>
  definePlugin({
    id: "routecraft.carddav",
    provides: [CARDDAV],
    bind(c) {
      const manager = new CarddavClientManager(options);
      c.provide(CARDDAV, manager);
      c.onDispose(() => manager.drain());
    },
  }),
);
