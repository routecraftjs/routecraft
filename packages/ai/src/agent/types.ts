import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { LlmModelId, LlmPromptSource, LlmUsage } from "../llm/types.ts";
import type { AgentEventListener } from "./events.ts";
import type { ToolSelection } from "./tools/selection.ts";

/**
 * Resolves a user prompt from an exchange. When omitted, the agent derives
 * the user prompt from `exchange.body` (string body as-is, JSON-stringified
 * for objects, `String()` otherwise).
 *
 * Alias of {@link LlmPromptSource} so the same prompt-source contract
 * applies to both the `agent` and `llm` destinations: pass a static
 * string for fixed prompts, or a function that derives the prompt from
 * the incoming exchange.
 *
 * @experimental
 */
export type AgentUserPromptSource = LlmPromptSource;

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

  /**
   * Default cap on tool-call steps for the Vercel AI SDK loop, applied
   * to agents that omit `maxSteps`. Each step is one model call (which
   * may emit any number of tool calls) plus the resulting tool results.
   * Resolves to `stopWhen: stepCountIs(maxSteps)` at dispatch.
   */
  maxSteps?: number;
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
   * System prompt. Either a static string or a function that derives
   * the prompt from the incoming exchange (mirrors `llm({ system })`).
   * Load from disk yourself when you want to source the static form
   * from a file (e.g. `readFileSync("./prompt.md", "utf-8")`).
   */
  system: LlmPromptSource;

  /**
   * Optional override for the user prompt. Either a static string or
   * a function that derives the prompt from the incoming exchange
   * (mirrors `llm({ user })`). Defaults to the exchange body (string
   * as-is, JSON for objects, `String()` otherwise) when omitted.
   */
  user?: LlmPromptSource;

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
   */
  output?: StandardSchemaV1;

  /**
   * Cap on tool-call steps for the Vercel AI SDK loop. Each step is
   * one model call (which may emit any number of tool calls) plus the
   * resulting tool results. Resolves to `stopWhen: stepCountIs(n)` at
   * dispatch. Defaults to 8 when neither the agent nor
   * `defaultOptions.maxSteps` supplies a value.
   */
  maxSteps?: number;

  /**
   * Listener invoked for each event emitted while the model + tool
   * loop runs. Setting this switches the dispatch from `generateText`
   * to `streamText` under the hood; the destination still returns a
   * consolidated {@link AgentResult} once the stream drains, so
   * downstream pipeline ops are unaffected.
   *
   * Use for live UI updates (SSE, WebSocket, console). For server-side
   * persistence or telemetry without a streamed UI, use the regular
   * (non-streaming) dispatch and read `AgentResult` directly.
   *
   * Listener errors are caught and logged, never propagate into the
   * dispatch. Async listeners are awaited so back-pressure on a slow
   * consumer flows back into the stream.
   *
   * Per-agent only; not part of `defaultOptions` because event sinks
   * are typically request-scoped (e.g. a per-connection SSE channel).
   */
  onEvent?: AgentEventListener;
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
  /**
   * Parsed structured output when an `output` schema was supplied on
   * `AgentOptions` and the model produced a value matching the schema.
   * Undefined otherwise.
   */
  output?: unknown;
  /**
   * Raw reasoning text from the provider when supplied (Anthropic
   * extended thinking, OpenAI o1, etc.). Useful for debugging and
   * audit; most consumers ignore it.
   */
  reasoning?: string;
  /** Token usage when reported by the provider. */
  usage?: LlmUsage;
}
