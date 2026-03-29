import type { CraftPlugin, CraftContext } from "../../context";
import { ADAPTER_DIRECT_OPTIONS, type DirectOptionsMerged } from "./shared";

/**
 * Direct plugin: registers context-level default options for all `direct()` adapters.
 *
 * Options set here are merged into every `direct()` adapter in the same context.
 * Per-adapter options always take precedence over plugin defaults.
 *
 * @param defaultOptions - Partial direct options applied to all `direct()` adapters
 * @returns A CraftPlugin to include in `CraftConfig.plugins`
 *
 * @example
 * ```typescript
 * import { directPlugin } from '@routecraft/routecraft'
 *
 * const config: CraftConfig = {
 *   plugins: [
 *     directPlugin({ description: 'Internal API' }),
 *   ],
 * }
 * ```
 */
export function directPlugin(
  defaultOptions: Partial<DirectOptionsMerged>,
): CraftPlugin {
  return {
    apply(ctx: CraftContext) {
      ctx.setStore(
        ADAPTER_DIRECT_OPTIONS as keyof import("@routecraft/routecraft").StoreRegistry,
        defaultOptions,
      );
    },
  };
}
