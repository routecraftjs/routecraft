import type { AgentRegisteredOptions } from "./types.ts";

/**
 * Store key for the registry of agents installed by `agentPlugin`. Resolved
 * at destination dispatch time when an agent is referenced by name via
 * `agent("name")`.
 *
 * @experimental
 */
export const ADAPTER_AGENT_REGISTRY = Symbol.for(
  "routecraft.adapter.agent.registry",
);

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [ADAPTER_AGENT_REGISTRY]: Map<string, AgentRegisteredOptions>;
  }
}
