import type { FnOptions } from "./types.ts";

/**
 * Store key for the registry of fns installed by `agentPlugin`. Resolved
 * at dispatch time by `invokeFn(...)` (and by the agent tool loop in
 * follow-up stories).
 *
 * @experimental
 */
export const ADAPTER_FN_REGISTRY = Symbol.for("routecraft.adapter.fn.registry");

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [ADAPTER_FN_REGISTRY]: Map<string, FnOptions>;
  }
}
