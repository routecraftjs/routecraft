/**
 * Type registries for AI adapter compile-time safety via declaration merging.
 *
 * Users populate these empty interfaces to constrain `llm()` and `mcp()`
 * adapters to only accept configured providers and servers. When a registry
 * is empty, the adapter falls back to accepting any string.
 *
 * @example
 * ```typescript
 * declare module '@routecraft/ai' {
 *   interface LlmProviderRegistry {
 *     openai: true;
 *     anthropic: true;
 *     ollama: true;
 *   }
 *   interface McpServerRegistry {
 *     github: true;
 *     'local-postgres': true;
 *   }
 * }
 *
 * // Now llm('openai:gpt-5') autocompletes the provider prefix.
 * // llm('qwen:model') shows a red line if qwen is not registered.
 * // mcp('github:create_issue') autocompletes server names.
 * ```
 */

import type { ResolveKey } from "@routecraft/routecraft";

/**
 * Registry for configured LLM providers.
 *
 * Keys are provider names (e.g. 'openai', 'anthropic', 'ollama'),
 * values should be `true`. Populate via declaration merging to constrain
 * the `llm()` adapter's model ID prefix.
 *
 * @experimental
 */
// biome-ignore lint/suspicious/noEmptyInterface: marker interface populated via declaration merging
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Marker interface, populated via declaration merging
export interface LlmProviderRegistry {}

/**
 * Registry for configured MCP servers.
 *
 * Keys are server names (e.g. 'github', 'local-postgres'),
 * values should be `true`. Populate via declaration merging to constrain
 * the `mcp()` adapter's shorthand syntax.
 *
 * @experimental
 */
// biome-ignore lint/suspicious/noEmptyInterface: marker interface populated via declaration merging
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Marker interface, populated via declaration merging
export interface McpServerRegistry {}

/**
 * Resolved LLM model ID type.
 * When `LlmProviderRegistry` is populated, constrains to `'provider:modelName'`
 * where provider must be a registered key. Falls back to `string` when empty.
 *
 * @experimental
 */
export type RegisteredLlmModelId = keyof LlmProviderRegistry extends never
  ? string
  : `${Extract<keyof LlmProviderRegistry, string>}:${string}`;

/**
 * Resolved MCP server key type.
 * When `McpServerRegistry` is populated, resolves to the union of registered server keys
 * (e.g. `'github' | 'local-postgres'`). Falls back to `string` when empty.
 *
 * For the full `'server:tool'` shorthand format, see `RegisteredMcpShorthand`.
 *
 * @experimental
 */
export type RegisteredMcpServer = ResolveKey<McpServerRegistry>;

/**
 * Resolved MCP shorthand type for 'server:tool' syntax.
 * When `McpServerRegistry` is populated, constrains the server prefix.
 * Falls back to `` `${string}:${string}` `` when empty.
 *
 * @experimental
 */
export type RegisteredMcpShorthand = keyof McpServerRegistry extends never
  ? `${string}:${string}`
  : `${Extract<keyof McpServerRegistry, string>}:${string}`;
