import type { AgentDefaultOptions, AgentRegisteredOptions } from "./types.ts";
import type { AgentToolPolicy } from "./tools/policy.ts";
import type { AgentSessionRuntime } from "./session/runtime.ts";

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
 * Every single-valued key of {@link AgentDefaultOptions}, exhaustive by
 * construction: the `satisfies` fails to compile when a key is added to that
 * interface and not listed here, and when a key listed here is not on it.
 * `blocks` is excluded because it is the one default that composes rather than
 * being taken whole.
 *
 * Both places that fold defaults into an agent walk this list: the merge
 * across two `agentPlugin` installs, and the merge of the stored defaults into
 * an agent's own options at dispatch. Enumerating the keys by hand in either
 * is how a default that installs correctly never reaches the model call.
 *
 * @internal
 */
export const AGENT_DEFAULT_OPTION_KEYS = Object.keys({
  model: true,
  tools: true,
  maxTurns: true,
  principal: true,
  temperature: true,
  maxTokens: true,
  topP: true,
  frequencyPenalty: true,
  presencePenalty: true,
  reasoning: true,
  providerOptions: true,
} satisfies Record<
  Exclude<keyof AgentDefaultOptions, "blocks">,
  true
>) as Array<Exclude<keyof AgentDefaultOptions, "blocks">>;

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

/**
 * Store key for the per-context session runtime, created on the first
 * dispatch that carries `session` and shared by every agent after that so
 * the one-turn-at-a-time bound holds across routes.
 * @internal
 */
export const ADAPTER_AGENT_SESSIONS = Symbol.for(
  "routecraft.adapter.agent.sessions",
);

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [ADAPTER_AGENT_SESSIONS]: AgentSessionRuntime;
    [ADAPTER_AGENT_REGISTRY]: Map<string, AgentRegisteredOptions>;
    [ADAPTER_AGENT_DEFAULT_OPTIONS]: AgentDefaultOptions;
    [ADAPTER_AGENT_TOOL_POLICIES]: AgentToolPolicy[];
  }
}
