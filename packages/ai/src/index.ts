// Side-effect import: augments `CraftConfig` with first-class `llm`, `mcp`,
// `embedding`, and `agent` keys, and registers the corresponding config
// appliers so those keys produce plugins on context startup.
import "./config.ts";

// Side-effect import: declares and registers this package's AI#### error
// codes in the core error registry (declaration merge + runtime metadata).
import "./errors.ts";

// Side-effect import: registers the `skills` and `agents` project
// discoverers so `craft start` can give those folders meaning without
// the CLI depending on this package.
import "./project.ts";

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
  isContextOverflow,
  llm,
  LlmEnricherAdapter,
  llmPlugin,
} from "./llm/index.ts";
export type {
  CustomLanguageModel,
  LlmAnthropicProviderOptions,
  LlmCustomProviderOptions,
  LlmGeminiProviderOptions,
  LlmLmStudioProviderOptions,
  LlmModelConfig,
  LlmModelConfigAnthropic,
  LlmModelConfigCustom,
  LlmModelConfigGemini,
  LlmModelConfigLmStudio,
  LlmModelConfigOllama,
  LlmModelConfigOpenAI,
  LlmModelConfigOpenRouter,
  LlmModelId,
  LlmOllamaProviderOptions,
  LlmOpenAIProviderOptions,
  LlmOpenRouterProviderOptions,
  LlmOptions,
  LlmFilePart,
  LlmImagePart,
  LlmPluginOptions,
  LlmPluginProviders,
  LlmPromptPart,
  LlmPromptSource,
  LlmProviderType,
  LlmRawProviderOptions,
  LlmReasoningEffort,
  LlmResult,
  LlmSamplingOptions,
  LlmTextPart,
  LlmToolCallSummary,
  LlmUsage,
  LlmUserPromptSource,
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
  defaultArgs,
  mcp,
  oauth,
  McpHeadersKeys,
  mcpPlugin,
  McpServer,
  McpToolRegistry,
  MCP_LOCAL_TOOL_REGISTRY,
  validateWithSchema,
  type McpLocalToolEntry,
  type McpOptions,
  type McpPluginOptions,
  type McpProxyToolConfig,
  type McpRawToolResult,
  type McpResourceOptions,
  type McpServerOptions,
  type McpStdioToolCaller,
  type McpTool,
  type McpToolAnnotations,
  type McpInput,
  type McpOutput,
  type McpIcon,
  type McpToolRegistryEntry,
  type McpToolResult,
  type OAuthFactoryOptions,
  type OAuthVerifier,
  type UserinfoFn,
  type UserinfoOption,
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
// For by-name use, register agents via `agentPlugin({ agents: { name: {...} } })`.
export {
  agent,
  AgentCancellationCause,
  AgentEnricherAdapter,
  agentPlugin,
  agents,
  assertResumableThread,
  replaceParkedThread,
  SuspendError,
  // Where agent sessions live: the config key's plugin form, the two
  // shipped backends, and the contract for a backend of your own.
  DEFAULT_SESSION_DB_PATH,
  MemorySessionStore,
  SESSION_STORE_ENV,
  SqliteSessionStore,
  sessionsPlugin,
} from "./agent/index.ts";
export type {
  AgentDefaultOptions,
  AgentByNameOverrides,
  AgentDelta,
  AgentInboxMessage,
  AgentMarkdownOverride,
  AgentDeltaListener,
  AgentOptions,
  AgentPluginOptions,
  AgentPrincipalRenderer,
  AgentRegisteredOptions,
  AgentResult,
  AgentSessionOutcome,
  AgentSessionsConfig,
  AgentInterruptSource,
  AgentSessionSource,
  AgentSessionSummary,
  SessionCasResult,
  SessionStore,
  SessionStoreConfig,
  StoredSession,
  AgentStepState,
  AgentStream,
  AgentSuspendOptions,
  AgentSuspendSentinel,
  AgentToolCallSummary,
  AgentUserPromptSource,
  ThreadMessage,
} from "./agent/index.ts";

// Fn primitive: ad-hoc in-process functions registered via
// `agentPlugin({ functions: { id: {...} } })`. Consumed exclusively by
// the agent tool loop (follow-up story); not directly invocable from
// user code. For tests, use `testFn` from `@routecraft/testing`.
export type {
  FnHandlerContext,
  FnOptions,
  FnRegistry,
  FnSessionView,
  FnSuspensionView,
  ReadonlyPrincipal,
  RegisteredFnId,
} from "./fn/index.ts";

// Tool builders: wrap registered routes as fn-shaped entries usable
// from `agentPlugin({ functions: { ... } })`, plus the `tools([...])`
// selector consumed by the agent runtime. MCP tools are referenced via
// the `MCP(server:tool)` / `mcp__server__tool` grammar inside
// `tools(...)`.
export {
  AgentHeadersKeys,
  directTool,
  tools,
  type AgentToolDescriptor,
  type AgentToolPolicy,
  type AgentToolPolicyContext,
  type AgentToolPolicyKind,
  type AgentToolPolicySource,
  type AgentToolRule,
  type AgentToolSource,
  type DeferredFn,
  type DeferredFnKind,
  type FnEntry,
  type ResolvedTool,
  type BackgroundToolHandle,
  type ToolBuilderOverrides,
  type ToolGuard,
  type ToolSelection,
  type ToolsBuilder,
  type ToolsCatalog,
  type ToolsItem,
} from "./agent/tools/index.ts";

// Block primitive: unified system-context contribution (skills, memory,
// identity, instructions). Inject mode concatenates content into the
// system prompt; progressive mode surfaces blocks as on-demand loader
// tools. `skills` loads markdown skills as blocks.
export {
  fromFile,
  skills,
  type AgentBlockLoadSummary,
  type BlockBody,
  type BlockClient,
  type BlockLifetime,
  type BlockMode,
  type BlockResolver,
  type Blocks,
  type SkillsOptions,
} from "./block/index.ts";

// Embedding adapter and plugin
export {
  embedding,
  EmbeddingEnricherAdapter,
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
