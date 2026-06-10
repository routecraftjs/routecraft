import { registerConfigApplier } from "../../config-applier.ts";
import type { StoreRegistry } from "../../context.ts";
import { CardDAVClientManager } from "./client-manager.ts";
import { CARDDAV_CLIENT_MANAGER } from "./shared.ts";
import type { CardDAVContextConfig } from "./types.ts";

declare module "@routecraft/routecraft" {
  interface CraftConfig {
    /** CardDAV adapter configuration with named accounts */
    carddav?: CardDAVContextConfig;
  }
}

/**
 * Register the `carddav` config key so `defineConfig({ carddav: {...} })`
 * constructs the shared {@link CardDAVClientManager} during `initPlugins()`
 * and drains it during plugin teardown (reverse plugin order, so user
 * plugins tear down first). Loaded as a side-effect import from
 * `packages/routecraft/src/index.ts`. Keeps the core context free of
 * CardDAV adapter knowledge.
 */
registerConfigApplier("carddav", (options) => {
  let manager: CardDAVClientManager | undefined;
  return {
    apply(ctx) {
      manager = new CardDAVClientManager(options);
      ctx.setStore(CARDDAV_CLIENT_MANAGER as keyof StoreRegistry, manager);
    },
    async teardown() {
      await manager?.drain();
    },
  };
});
