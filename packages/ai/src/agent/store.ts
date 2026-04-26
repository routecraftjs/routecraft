import type { AgentRegisteredOptions } from "./types.ts";
import type { ToolSelection } from "./tools/selection.ts";

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

/**
 * Store key for the context-default tool selection installed via
 * `agentPlugin({ tools })`. Agents that omit their own `tools:` field
 * fall back to this list at dispatch time.
 *
 * @experimental
 */
export const ADAPTER_TOOLS_DEFAULT = Symbol.for(
  "routecraft.adapter.tools.default",
);

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [ADAPTER_AGENT_REGISTRY]: Map<string, AgentRegisteredOptions>;
    [ADAPTER_TOOLS_DEFAULT]: ToolSelection;
  }
}
