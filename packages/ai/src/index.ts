// Cross-instance identity (Symbol.for) for MCP adapters
export { BRAND, isMcpAdapter } from "./brand.ts";

// LLM adapter and plugin
export {
  ADAPTER_LLM_PROVIDERS,
  ADAPTER_LLM_OPTIONS,
  llm,
  LlmAdapter,
  llmPlugin,
  validateLlmPluginOptions,
} from "./llm/index.ts";
export type {
  LlmAnthropicProviderOptions,
  LlmGeminiProviderOptions,
  LlmModelConfig,
  LlmModelConfigAnthropic,
  LlmModelConfigGemini,
  LlmModelConfigOllama,
  LlmModelConfigOpenAI,
  LlmModelConfigOpenRouter,
  LlmModelId,
  LlmOllamaProviderOptions,
  LlmOpenAIProviderOptions,
  LlmOpenRouterProviderOptions,
  LlmOptions,
  LlmPluginOptions,
  LlmPluginProviders,
  LlmPromptSource,
  LlmProviderType,
  LlmResult,
  LlmUsage,
} from "./llm/index.ts";

// MCP DSL, adapter, and types
export {
  ADAPTER_MCP_CLIENT_SERVERS,
  defaultArgs,
  mcp,
  McpAdapter,
  mcpPlugin,
  McpServer,
  MCP_PLUGIN_REGISTERED,
  validateWithSchema,
  type McpOptions,
  type McpPluginOptions,
  type McpServerOptions,
  type McpTool,
  type McpToolResult,
} from "./mcp/index.ts";
export type {
  McpArgsExtractor,
  McpClientHttpConfig,
  McpClientOptions,
  McpClientServerConfig,
  McpClientStdioConfig,
} from "./mcp/types.ts";

// Agent adapter (Phase 1: pass-through)
export { agent, AgentAdapter } from "./agent/index.ts";
export type {
  AgentModelId,
  AgentOptions,
  AgentPromptSource,
  AgentResult,
} from "./agent/index.ts";

// Embedding adapter and plugin
export {
  embedding,
  EmbeddingAdapter,
  embeddingPlugin,
  disposeEmbeddingPipelineCache,
} from "./embedding/index.ts";
export type {
  EmbeddingModelConfig,
  EmbeddingModelConfigHuggingFace,
  EmbeddingModelConfigOllama,
  EmbeddingModelConfigOpenAI,
  EmbeddingModelId,
  EmbeddingOptions,
  EmbeddingPluginOptions,
  EmbeddingPluginProviders,
  EmbeddingProviderType,
  EmbeddingResult,
} from "./embedding/index.ts";
