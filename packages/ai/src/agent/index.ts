export { agent } from "./agent.ts";
export { AgentDestinationAdapter, type AgentBinding } from "./destination.ts";
export { agentPlugin, type AgentPluginOptions } from "./plugin.ts";
export { ADAPTER_AGENT_REGISTRY } from "./store.ts";
export type {
  AgentOptions,
  AgentRegisteredOptions,
  AgentResult,
  AgentUserPromptSource,
} from "./types.ts";
