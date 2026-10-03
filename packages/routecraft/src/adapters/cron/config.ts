import { registerConfigApplier } from "../../config-applier.ts";
import { definePlugin } from "../../kernel/plugin.ts";
import { CRON_DEFAULTS } from "./source.ts";
import type { CronOptions } from "./types.ts";

declare module "@routecraft/routecraft" {
  interface CraftConfig {
    /** Default options applied to all cron() sources in this context */
    cron?: Partial<CronOptions>;
  }
}

/**
 * Register the `cron` config key so `defineConfig({ cron: {...} })` seeds
 * the context store with default cron options. Loaded as a side-effect
 * import from `packages/routecraft/src/index.ts` so users do not have to
 * wire it manually. Keeps the core context free of cron adapter knowledge.
 */
registerConfigApplier("cron", (options) =>
  definePlugin({
    id: "routecraft.cron",
    provides: [CRON_DEFAULTS],
    bind(c) {
      c.provide(CRON_DEFAULTS, options);
    },
  }),
);
