import { registerConfigApplier } from "@routecraft/routecraft";
import { llmPlugin } from "./llm/plugin.ts";
import { mcpPlugin } from "./mcp/plugin.ts";
import { embeddingPlugin } from "./embedding/plugin.ts";
import { agentPlugin } from "./agent/plugin.ts";
import type { LlmPluginOptions } from "./llm/types.ts";
import type { McpPluginOptions } from "./mcp/types.ts";
import type { EmbeddingPluginOptions } from "./embedding/types.ts";
import type { AgentPluginOptions } from "./agent/plugin.ts";

/**
 * Promote AI ecosystem plugins to first-class keys on `CraftConfig`. Once
 * `@routecraft/ai` is imported, users can write:
 *
 * ```typescript
 * import { defineConfig } from "@routecraft/routecraft";
 * import "@routecraft/ai";
 *
 * export default defineConfig({
 *   llm: { providers: { openai: { apiKey: "..." } } },
 *   mcp: { clients: { ... } },
 *   embedding: { providers: { ... } },
 *   agent: { agents: { ... }, functions: { ... } },
 * });
 * ```
 *
 * Each key carries the same options as the corresponding plugin factory and
 * participates in the standard plugin lifecycle (registered/starting/started
 * /stopping/stopped events; teardown on shutdown).
 *
 * The existing `llmPlugin`, `mcpPlugin`, `embeddingPlugin`, and `agentPlugin`
 * factories remain available for use via `plugins: [...]` (e.g. for shared
 * plugin instances or programmatic composition).
 */
declare module "@routecraft/routecraft" {
  interface CraftConfig {
    /** LLM provider configuration. Equivalent to `plugins: [llmPlugin(...)]`. */
    llm?: LlmPluginOptions;
    /** MCP server / client configuration. Equivalent to `plugins: [mcpPlugin(...)]`. */
    mcp?: McpPluginOptions;
    /** Embedding provider configuration. Equivalent to `plugins: [embeddingPlugin(...)]`. */
    embedding?: EmbeddingPluginOptions;
    /** Agent and tool registry. Equivalent to `plugins: [agentPlugin(...)]`. */
    agent?: AgentPluginOptions;
  }
}

registerConfigApplier("llm", (options) => llmPlugin(options));
registerConfigApplier("mcp", (options) => mcpPlugin(options));
registerConfigApplier("embedding", (options) => embeddingPlugin(options));
registerConfigApplier("agent", (options) => agentPlugin(options));
