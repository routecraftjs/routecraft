import { registerConfigApplier } from "../../config-applier.ts";
import type { StoreRegistry } from "../../context.ts";
import { ADAPTER_DIRECT_OPTIONS } from "./shared.ts";
import type { DirectBaseOptions } from "./types.ts";

declare module "@routecraft/routecraft" {
  interface CraftConfig {
    /** Default channel implementation for all direct() adapters (e.g. swap in-memory for Kafka) */
    direct?: Pick<DirectBaseOptions, "channelType">;
  }
}

/**
 * Register the `direct` config key so `defineConfig({ direct: {...} })`
 * seeds the context store with channel defaults. Loaded as a side-effect
 * import from `packages/routecraft/src/index.ts` so users do not have to
 * wire it manually. Keeps the core context free of direct adapter knowledge.
 */
registerConfigApplier("direct", (options) => ({
  apply(ctx) {
    ctx.setStore(ADAPTER_DIRECT_OPTIONS as keyof StoreRegistry, options);
  },
}));
