import type { AgentDefaultOptions, AgentRegisteredOptions } from "./types.ts";
import type { AgentToolPolicy } from "./tools/policy.ts";

/**
 * Store key for the registry of agents installed by `agentPlugin`. Resolved
 * at destination dispatch time when an agent is referenced by name via
 * `agent("name")`.
 * @internal
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
 * @internal
 */
export const ADAPTER_AGENT_DEFAULT_OPTIONS = Symbol.for(
  "routecraft.adapter.agent.default-options",
);

/**
 * Store key for the tool policies installed via
 * `agentPlugin({ toolPolicy })`.
 *
 * An array rather than a single value, because multiple `agentPlugin`
 * installs compose with AND: each contributes a policy and a tool must
 * satisfy all of them. Kept out of `ADAPTER_AGENT_DEFAULT_OPTIONS` on
 * purpose, since defaults are per-agent overridable and a policy must
 * not be.
 * @internal
 */
export const ADAPTER_AGENT_TOOL_POLICIES = Symbol.for(
  "routecraft.adapter.agent.tool-policies",
);

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [ADAPTER_AGENT_REGISTRY]: Map<string, AgentRegisteredOptions>;
    [ADAPTER_AGENT_DEFAULT_OPTIONS]: AgentDefaultOptions;
    [ADAPTER_AGENT_TOOL_POLICIES]: AgentToolPolicy[];
  }
}
