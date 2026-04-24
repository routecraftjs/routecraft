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

// Auth primitives re-exported from core for convenience.
// Canonical location: @routecraft/routecraft
export {
  jwt,
  jwks,
  type ClaimMappers,
  type JwtAudience,
  type JwtAuthOptions,
  type JwtHmacOptions,
  type JwtRsaOptions,
  type JwksOptions,
  type OAuthPrincipal,
  type OAuthTokenVerifier,
  type OAuthValidatorAuthOptions,
  type Principal,
  type TokenVerifier,
  type ValidatorAuthOptions,
} from "@routecraft/routecraft";

// MCP DSL, adapter, and types
export {
  ADAPTER_MCP_CLIENT_SERVERS,
  BRAND_MCP_ADAPTER,
  defaultArgs,
  isOAuthAuth,
  mcp,
  oauth,
  McpHeadersKeys,
  mcpPlugin,
  McpServer,
  McpToolRegistry,
  MCP_LOCAL_TOOL_REGISTRY,
  MCP_PLUGIN_REGISTERED,
  MCP_STDIO_MANAGERS,
  MCP_TOOL_REGISTRY,
  validateWithSchema,
  type McpLocalToolEntry,
  type McpOptions,
  type McpPluginOptions,
  type McpServerOptions,
  type McpTool,
  type McpToolAnnotations,
  type McpInput,
  type McpOutput,
  type McpToolIcon,
  type McpToolRegistryEntry,
  type McpToolResult,
  type OAuthAuthOptions,
  type OAuthClientInfo,
  type OAuthClientSupplier,
  type OAuthFactoryOptions,
  type OAuthProxyEndpoints,
  type OAuthVerifier,
} from "./mcp/index.ts";
export type {
  McpClientAuthOptions,
  McpClientOptions,
  McpClientServerConfig,
  McpClientStdioConfig,
  McpClientTokenProvider,
  McpHttpAuthOptions,
} from "./mcp/types.ts";
export type {
  McpArgsExtractor,
  McpClientHttpConfig,
  McpMessage,
} from "./mcp/index.ts";

// Agent destination, plugin, and types. For inline use, identity and
// description come from the enclosing route (`.id()`, `.description()`).
// For by-name use, register agents via `agentPlugin({ agents: [...] })`
// with `defineAgent({ id, description, ... })`.
export {
  agent,
  defineAgent,
  AgentDestinationAdapter,
  agentPlugin,
  ADAPTER_AGENT_REGISTRY,
} from "./agent/index.ts";
export type {
  AgentBinding,
  AgentOptions,
  AgentPluginOptions,
  AgentRegisteredOptions,
  AgentRegistration,
  AgentResult,
  AgentUserPromptSource,
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
