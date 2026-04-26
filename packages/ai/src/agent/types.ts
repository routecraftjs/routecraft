import type { Exchange } from "@routecraft/routecraft";
import type { LlmModelConfig, LlmModelId, LlmUsage } from "../llm/types.ts";
import type { ToolSelection } from "./tools/selection.ts";

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

  /**
   * Tools the agent is allowed to call. Build via
   * `tools([...])` from `@routecraft/ai`. Resolved against the live
   * fn / direct registries at agent dispatch time.
   *
   * When omitted, the agent inherits the context-default tool list set
   * via `agentPlugin({ tools })`. An explicit value here replaces the
   * default entirely (no extension).
   */
  tools?: ToolSelection;
}

/**
 * Options for an agent registered via `agentPlugin({ agents: { ... } })` for
 * by-name reuse. Registered agents carry their own description because they
 * are not backed by a route. The id is the record key in the plugin config.
 *
 * @experimental
 */
export interface AgentRegisteredOptions extends AgentOptions {
  /**
   * Human-readable description. Surfaces in observability and is used as the
   * tool description when the agent is exposed to other agents.
   */
  description: string;
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
