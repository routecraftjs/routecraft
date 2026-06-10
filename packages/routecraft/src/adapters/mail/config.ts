import { registerConfigApplier } from "../../config-applier.ts";
import type { StoreRegistry } from "../../context.ts";
import { MailClientManager } from "./client-manager.ts";
import { MAIL_CLIENT_MANAGER } from "./shared.ts";
import type { MailContextConfig } from "./types.ts";

declare module "@routecraft/routecraft" {
  interface CraftConfig {
    /** Mail adapter configuration with named accounts */
    mail?: MailContextConfig;
  }
}

/**
 * Register the `mail` config key so `defineConfig({ mail: {...} })`
 * constructs the shared {@link MailClientManager} during `initPlugins()`
 * and drains it during plugin teardown (reverse plugin order, so user
 * plugins tear down first). Loaded as a side-effect import from
 * `packages/routecraft/src/index.ts`. Keeps the core context free of
 * mail adapter knowledge.
 */
registerConfigApplier("mail", (options) => {
  let manager: MailClientManager | undefined;
  return {
    apply(ctx) {
      manager = new MailClientManager(options);
      ctx.setStore(MAIL_CLIENT_MANAGER as keyof StoreRegistry, manager);
    },
    async teardown() {
      await manager?.drain();
    },
  };
});
