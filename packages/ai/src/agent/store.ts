import type { AgentDefaultOptions, AgentRegisteredOptions } from "./types.ts";

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
 * Store key for the context-level agent defaults installed via
 * `agentPlugin({ defaultOptions: {...} })`. Agents that omit a field
 * inherit it from here at dispatch time.
 *
 * Mirrors the `llmPlugin({ defaultOptions })` pattern so the same merge
 * model carries across.
 *
 * @experimental
 */
export const ADAPTER_AGENT_DEFAULT_OPTIONS = Symbol.for(
  "routecraft.adapter.agent.default-options",
);

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [ADAPTER_AGENT_REGISTRY]: Map<string, AgentRegisteredOptions>;
    [ADAPTER_AGENT_DEFAULT_OPTIONS]: AgentDefaultOptions;
  }
}
