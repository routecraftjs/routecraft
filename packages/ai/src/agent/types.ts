import type { Exchange } from "@routecraft/routecraft";
import type { LlmModelConfig, LlmModelId, LlmUsage } from "../llm/types.ts";

/**
 * Brand symbol used to distinguish agent registrations from inline option
 * objects. `defineAgent()` stamps this on its return value so `agentPlugin`
 * can tell at runtime whether it was given a registration or a plain
 * config.
 *
 * @internal
 */
export const AGENT_REGISTRATION_BRAND: unique symbol = Symbol.for(
  "routecraft.agent.registration",
);

/**
 * Resolves a user prompt from an exchange. When omitted, the agent derives
 * the user prompt from `exchange.body` (string body as-is, JSON-stringified
 * for objects, `String()` otherwise).
 *
 * @experimental
 */
export type AgentUserPromptSource = (exchange: Exchange<unknown>) => string;

/**
 * Options for the agent destination when defined inline in a route.
 *
 * Identity and description for inline agents live on the enclosing route:
 * `.id()` is the agent's callable identity and `.description()` is its
 * human-readable description. `AgentOptions` only carries LLM-specific
 * config.
 *
 * For registered agents that are not backed by a route, use
 * `defineAgent({ id, description, ...AgentOptions })` together with
 * `agentPlugin({ agents: [...] })`. The `id` and `description` fields
 * only apply to the registered form and are not accepted on inline
 * `agent({...})` calls.
 *
 * @experimental
 */
export interface AgentOptions {
  /**
   * Model reference. Either a "providerId:modelName" string resolved against
   * the providers registered via `llmPlugin`, or an inline `LlmModelConfig`
   * for ad-hoc credentials without registration.
   */
  model: LlmModelId | LlmModelConfig;

  /**
   * System prompt as a plain string. Load from disk yourself when you want
   * to source it from a file (e.g. `readFileSync("./prompt.md", "utf-8")`).
   */
  system: string;

  /**
   * Optional override for deriving the user prompt from the incoming
   * exchange. Defaults to the body (string as-is, JSON for objects).
   */
  user?: AgentUserPromptSource;
}

/**
 * Options for an agent registered via `agentPlugin({ agents: [...] })` for
 * by-name reuse. Registered agents carry their own id and description
 * because there is no enclosing route to draw them from.
 *
 * @experimental
 */
export interface AgentRegisteredOptions extends AgentOptions {
  /** Unique identifier used to reference this agent via `agent("id")`. */
  id: string;
  /**
   * Human-readable description. Surfaces in observability and is used as the
   * tool description when the agent is exposed to other agents.
   */
  description: string;
}

/**
 * Agent registration produced by `defineAgent()`. Pass to
 * `agentPlugin({ agents: [...] })`.
 *
 * @experimental
 */
export interface AgentRegistration {
  readonly [AGENT_REGISTRATION_BRAND]: true;
  readonly options: AgentRegisteredOptions;
}

/**
 * Result produced by an agent destination. Body of the exchange is replaced
 * with this shape after the agent runs.
 *
 * @experimental
 */
export interface AgentResult {
  /** Generated text from the model. */
  text: string;
  /** Token usage when reported by the provider. */
  usage?: LlmUsage;
}
