// Cross-instance identity (Symbol.for) for MCP adapters
export { BRAND, isMcpAdapter } from "./brand.ts";

// Type registries for compile-time safety
export type {
  LlmProviderRegistry,
  McpServerRegistry,
  RegisteredLlmModelId,
  RegisteredMcpServer,
  RegisteredMcpShorthand,
} from "./registry.ts";

// LLM adapter and plugin
export {
  ADAPTER_LLM_PROVIDERS,
  ADAPTER_LLM_OPTIONS,
  llm,
  LlmDestinationAdapter,
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
  BRAND_MCP_ADAPTER,
  defaultArgs,
  mcp,
  mcpPlugin,
  McpServer,
  McpToolRegistry,
  MCP_PLUGIN_REGISTERED,
  MCP_STDIO_MANAGERS,
  MCP_TOOL_REGISTRY,
  validateWithSchema,
  type McpArgsExtractor,
  type McpClientHttpConfig,
  type McpMessage,
  type McpOptions,
  type McpPluginOptions,
  type McpServerOptions,
  type McpTool,
  type McpToolRegistryEntry,
  type McpToolResult,
} from "./mcp/index.ts";
export type {
  McpClientAuthOptions,
  McpClientOptions,
  McpClientServerConfig,
  McpClientStdioConfig,
  McpHttpAuthOptions,
  McpTokenValidator,
} from "./mcp/types.ts";

// Agent adapter (Phase 1: pass-through)
export { agent, AgentDestinationAdapter } from "./agent/index.ts";
export type {
  AgentModelId,
  AgentOptions,
  AgentPromptSource,
  AgentResult,
} from "./agent/index.ts";

// Embedding adapter and plugin
export {
  embedding,
  EmbeddingDestinationAdapter,
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
