import { registerConfigApplier } from "../../config-applier.ts";
import { directPlugin } from "../../plugins/direct/index.ts";
import type { DirectBaseOptions } from "./types.ts";

declare module "@routecraft/routecraft" {
  interface CraftConfig {
    /** Default channel implementation for all direct() adapters (e.g. swap in-memory for Kafka) */
    direct?: Pick<DirectBaseOptions, "channelType">;
  }
}

/**
 * Register the `direct` config key so `defineConfig({ direct: {...} })`
 * installs `routecraft.direct` with channel defaults in place of the default
 * one. Loaded as a side-effect import from `packages/routecraft/src/index.ts`
 * so users do not have to wire it manually.
 */
registerConfigApplier("direct", (options) => directPlugin(options));
