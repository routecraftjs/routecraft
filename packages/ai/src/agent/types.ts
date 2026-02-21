import type { Exchange } from "@routecraft/routecraft";

/** Resolve prompt from exchange (string or function). */
export type AgentPromptSource =
  | string
  | ((exchange: Exchange<unknown>) => string);

/**
 * Options for the agent adapter (anonymous inline only in Phase 1).
 * modelId format: "providerId:modelName" (e.g. ollama:llama3).
 */
export interface AgentOptions {
  /** Model id in "providerId:modelName" format; provider resolved from llmPlugin/store. */
  modelId: string;
  /** System prompt (optional). Defaults to exchange.body for user prompt when not set. */
  systemPrompt?: AgentPromptSource;
  /** User prompt (optional). Default: exchange.body. */
  userPrompt?: AgentPromptSource;
  /** Route IDs the agent may call; default: all. Empty array = all. */
  allowedRoutes?: string[];
  /** MCP serverIds the agent may call; default: none. */
  allowedMcpServers?: string[];
  /** Max agent loop steps (safety cap). Default: 10. */
  maxSteps?: number;
}

/** Result from agent adapter. Phase 1: pass-through returns output = exchange.body, steps = 0. */
export interface AgentResult {
  /** Final agent output (pass-through in Phase 1). */
  output: unknown;
  /** Number of loop iterations (0 in Phase 1). */
  steps?: number;
}
