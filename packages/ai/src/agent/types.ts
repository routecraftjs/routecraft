import type { Exchange } from "@routecraft/routecraft";

/** Resolve prompt from exchange (string or function). */
export type AgentPromptSource =
  | string
  | ((exchange: Exchange<unknown>) => string);

/**
 * Recommended agent model ids for autocomplete (reasoning, tool use, multi-step).
 * Format: "providerId:modelName". Custom models are allowed via string.
 * Updated for 2026.
 */
export type AgentModelId =
  // OpenAI (2026: GPT-5.2, Codex, o1 for reasoning/tools)
  | "openai:gpt-5.2"
  | "openai:gpt-5.2-codex"
  | "openai:gpt-5"
  | "openai:gpt-5.1-chat-latest"
  | "openai:gpt-4o"
  | "openai:o1"
  | "openai:o1-mini"
  // Anthropic (2026: Claude 4.6 / 4.5 agentic)
  | "anthropic:claude-opus-4-6"
  | "anthropic:claude-sonnet-4-6"
  | "anthropic:claude-haiku-4-5-20251001"
  // Ollama (local agent / reasoning)
  | "ollama:qwen3"
  | "ollama:llama3.2"
  | "ollama:llama3.3"
  | "ollama:deepseek-r1"
  | "ollama:lfm2.5-thinking"
  | "ollama:mistral"
  | "ollama:gemma2"
  // OpenRouter (open-weight / frontier: GLM, Kimi, Qwen, DeepSeek)
  | "openrouter:z-ai/glm-5"
  | "openrouter:z-ai/glm-4.7"
  | "openrouter:moonshotai/kimi-k2-thinking"
  | "openrouter:qwen/qwen3.5-plus-02-15"
  | "openrouter:deepseek/deepseek-v3.2"
  | "openrouter:deepseek/deepseek-r1"
  | "openrouter:google/gemini-2.5-pro"
  // Gemini (2026: 2.5 + 3.x reasoning)
  | "gemini:gemini-2.5-pro"
  | "gemini:gemini-3.1-pro-preview"
  | "gemini:gemini-3-pro-preview"
  | "gemini:gemini-2.5-flash"
  // Other (custom models)
  | string;

/**
 * Options for the agent adapter (anonymous inline only in Phase 1).
 * modelId format: "providerId:modelName" (e.g. ollama:llama3).
 */
export interface AgentOptions {
  /** Model id in "providerId:modelName" format; provider resolved from llmPlugin/store. */
  modelId: AgentModelId;
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
