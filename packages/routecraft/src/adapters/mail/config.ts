import { registerConfigApplier } from "../../config-applier.ts";
import { definePlugin } from "../../kernel/plugin.ts";
import { MailClientManager } from "./client-manager.ts";
import { MAIL } from "./shared.ts";
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
registerConfigApplier("mail", (options) =>
  definePlugin({
    id: "routecraft.mail",
    provides: [MAIL],
    bind(c) {
      const manager = new MailClientManager(options);
      c.provide(MAIL, manager);
      c.onDispose(() => manager.drain());
    },
  }),
);
