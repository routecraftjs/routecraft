import { registerConfigApplier } from "@routecraft/routecraft";
import { llmPlugin } from "./llm/plugin.ts";
import { mcpPlugin } from "./mcp/plugin.ts";
import { embeddingPlugin } from "./embedding/plugin.ts";
import { agentPlugin } from "./agent/plugin.ts";
import type { LlmPluginOptions } from "./llm/types.ts";
import type { McpPluginOptions } from "./mcp/types.ts";
import type { EmbeddingPluginOptions } from "./embedding/types.ts";
import type { AgentPluginOptions } from "./agent/plugin.ts";
import { sessionsPlugin } from "./agent/session/config.ts";
import type { AgentSessionsConfig } from "./agent/session/config.ts";
import { acpPlugin } from "./acp/plugin.ts";
import type { AcpPluginOptions } from "./acp/types.ts";

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
 *   sessions: { store: { path: "/data/sessions.db" } },
 *   acp: { auth: apiKeyAuth },
 * });
 * ```
 *
 * Each key carries the same options as the corresponding plugin factory and
 * participates in the standard plugin lifecycle (registered/starting/started
 * /stopping/stopped events; teardown on shutdown).
 *
 * Appliers run in the order they are registered here, whatever order the
 * keys are written in, and before anything in `plugins`. That is what
 * lets `acp` build its routes from the agents `agent` registered (and
 * `craft start` discovered into `agent`), in any key order, where the
 * `plugins: [acpPlugin()]` form has to be listed after `agentPlugin()`.
 *
 * The existing `llmPlugin`, `mcpPlugin`, `embeddingPlugin`, `agentPlugin`
 * and `acpPlugin` factories remain available for use via `plugins: [...]`
 * (e.g. for shared plugin instances or programmatic composition).
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
    /**
     * Where agent session records live. Optional: without it the sqlite
     * backend at `.routecraft/sessions.db` is opened on the first session.
     */
    sessions?: AgentSessionsConfig;
    /**
     * Serve the Agent Client Protocol. Equivalent to
     * `plugins: [acpPlugin(...)]`, applied after `agent` in any key order.
     */
    acp?: AcpPluginOptions;
  }
}

registerConfigApplier("llm", (options) => llmPlugin(options));
registerConfigApplier("mcp", (options) => mcpPlugin(options));
registerConfigApplier("embedding", (options) => embeddingPlugin(options));
registerConfigApplier("agent", (options) => agentPlugin(options));
registerConfigApplier("sessions", (options) => sessionsPlugin(options));
// Last on purpose: it reads the registry `agent` filled.
registerConfigApplier("acp", (options) => acpPlugin(options));
