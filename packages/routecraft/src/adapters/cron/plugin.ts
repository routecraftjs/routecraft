import type { CraftPlugin, CraftContext } from "../../context";
import { ADAPTER_CRON_OPTIONS } from "./source";
import type { CronOptions } from "./types";

/**
 * Cron plugin: registers context-level default options for all `cron()` sources.
 *
 * Options set here are merged into every `cron()` adapter in the same context.
 * Per-adapter options always take precedence over plugin defaults.
 *
 * @param defaultOptions - Partial cron options applied to all `cron()` sources
 * @returns A CraftPlugin to include in `CraftConfig.plugins`
 *
 * @example
 * ```typescript
 * import { cronPlugin } from '@routecraft/routecraft'
 *
 * const config: CraftConfig = {
 *   plugins: [
 *     cronPlugin({ timezone: 'UTC', jitterMs: 2000 }),
 *   ],
 * }
 * ```
 */
export function cronPlugin(defaultOptions: Partial<CronOptions>): CraftPlugin {
  return {
    apply(ctx: CraftContext) {
      ctx.setStore(
        ADAPTER_CRON_OPTIONS as keyof import("@routecraft/routecraft").StoreRegistry,
        defaultOptions,
      );
    },
  };
}
