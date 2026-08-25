import type { FnEntry } from "../agent/tools/types.ts";
import type { FnOptions } from "./types.ts";

/**
 * Store key for the registry of fns installed by `agentPlugin`. Read by
 * the agent tool loop at dispatch time (follow-up story).
 *
 * Entries are either eagerly authored `FnOptions` or deferred
 * descriptors emitted by `directTool`. The agent runtime resolves
 * deferred entries on first dispatch when all registries are live.
 * @internal
 */
export const ADAPTER_FN_REGISTRY = Symbol.for("routecraft.adapter.fn.registry");

/**
 * Resolved `FnOptions` for deferred entries, keyed by the id they are
 * registered under.
 *
 * A context store rather than a module-level map, for the reason the
 * store keys exist: two copies of this package in one dependency tree
 * hold separate module state but share the context, so a module-level
 * memo would resolve the same tool once per copy. `Symbol.for` is what
 * makes the key itself identical across those copies.
 *
 * @internal
 */
export const ADAPTER_FN_RESOLVED = Symbol.for("routecraft.adapter.fn.resolved");

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [ADAPTER_FN_REGISTRY]: Map<string, FnEntry>;
    [ADAPTER_FN_RESOLVED]: Map<string, FnOptions>;
  }
}
