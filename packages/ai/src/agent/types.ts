import type { Exchange } from "@routecraft/routecraft";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { LlmModelId, LlmUsage } from "../llm/types.ts";
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
 * Context-level defaults applied to any agent that doesn't override them.
 * Set via `agentPlugin({ defaultOptions: {...} })`. Per-agent values
 * win over these.
 *
 * Mirrors the `llmPlugin({ defaultOptions })` shape so the same mental
 * model carries across.
 *
 * @experimental
 */
export interface AgentDefaultOptions {
  /**
   * Default model reference. Format: "providerId:modelName". The
   * provider must be registered via `llmPlugin({ providers })`.
   *
   * Agents that omit `model` inherit this default at dispatch time.
   * Both this default and the per-agent `model` are `LlmModelId`
   * strings. Agents do not author provider credentials inline; that
   * responsibility lives with `llmPlugin`.
   */
  model?: LlmModelId;

  /**
   * Default tool selection. Build via `tools([...])` from
   * `@routecraft/ai`. Agents that omit `tools` inherit this default;
   * an explicit `tools:` on the agent replaces this default entirely
   * (override, not extend).
   */
  tools?: ToolSelection;
}

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
   * Model reference of the form "providerId:modelName". The provider
   * must be registered via `llmPlugin({ providers })`. Optional when
   * `agentPlugin({ defaultOptions: { model } })` supplies a default;
   * resolution at dispatch is "instance value > plugin default >
   * throw RC5003".
   */
  model?: LlmModelId;

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
   * When omitted, the agent inherits the default set on
   * `agentPlugin({ defaultOptions: { tools } })`. An explicit value
   * here replaces the default entirely (no extension).
   */
  tools?: ToolSelection;

  /**
   * Optional output schema (Standard Schema). When set, the agent
   * requests provider-level structured output and validates the
   * result; the parsed value lands on `AgentResult.output`.
   *
   * Mirrors the `llm({ output })` option and the route-level
   * `.output(schema)` builder method, so the same word is used for
   * "declared output shape" everywhere in the framework. Per-agent
   * only (not part of `defaultOptions`), since output shape is
   * intrinsic to a specific agent's job.
   *
   * The runtime that wires this through `generateText({ output })`
   * lands in the next PR; defining this field today is accepted by
   * validation but does not yet shape the dispatch.
   */
  output?: StandardSchemaV1;
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
