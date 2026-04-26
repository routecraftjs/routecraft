import type { FnEntry } from "../agent/tools/types.ts";

/**
 * Store key for the registry of fns installed by `agentPlugin`. Read by
 * the agent tool loop at dispatch time (follow-up story).
 *
 * Entries are either eagerly authored `FnOptions` or deferred
 * descriptors emitted by `directTool` / `agentTool` / `mcpTool`. The
 * agent runtime resolves deferred entries on first dispatch when all
 * registries are live.
 *
 * @experimental
 */
export const ADAPTER_FN_REGISTRY = Symbol.for("routecraft.adapter.fn.registry");

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [ADAPTER_FN_REGISTRY]: Map<string, FnEntry>;
  }
}
