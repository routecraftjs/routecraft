import type { AgentDefaultOptions } from "./types.ts";
import type { AgentSessionRuntime } from "./session/runtime.ts";
import type { ResolvedSessionStore } from "./session/port.ts";

/**
 * Every single-valued key of {@link AgentDefaultOptions}, exhaustive by
 * construction: the `satisfies` fails to compile when a key is added to that
 * interface and not listed here, and when a key listed here is not on it.
 * `blocks` is excluded because it is the one default that composes rather than
 * being taken whole.
 *
 * Both places that fold defaults into an agent walk this list: the merge
 * across two `agentPlugin` installs, and the merge of the registered defaults
 * into an agent's own options at dispatch. Enumerating the keys by hand in
 * either is how a default that installs correctly never reaches the model
 * call.
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
 * Store key for the session runtime of an application with no agent
 * runtime installed, created on the first inline `agent({ session })`
 * dispatch. With the agent runtime installed its registry holds the
 * runtime instead. Written and read only by the session runtime.
 *
 * @internal
 */
export const ADAPTER_AGENT_SESSIONS = Symbol.for(
  "routecraft.adapter.agent.sessions",
);

/**
 * Store key for the session store resolved on first use when no sessions
 * plugin provides one. Written and read only by the session store module.
 *
 * @internal
 */
export const ADAPTER_AGENT_SESSION_STORE = Symbol.for(
  "routecraft.adapter.agent.sessions.store",
);

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [ADAPTER_AGENT_SESSIONS]: AgentSessionRuntime;
    [ADAPTER_AGENT_SESSION_STORE]: ResolvedSessionStore;
  }
}
