import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { LlmModelId, LlmPromptSource, LlmUsage } from "../llm/types.ts";
import type { AgentDeltaListener } from "./events.ts";
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
   * Default cap on tool-calling turns for the Vercel AI SDK loop,
   * applied to agents that omit `maxTurns`. Each turn is one model
   * call (which may emit any number of tool calls) plus the resulting
   * tool results. Resolves to `stopWhen: stepCountIs(maxTurns)` at
   * dispatch.
   */
  maxTurns?: number;
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
   * Cap on tool-calling turns for the Vercel AI SDK loop. Each turn
   * is one model call (which may emit any number of tool calls) plus
   * the resulting tool results. Resolves to `stopWhen: stepCountIs(n)`
   * at dispatch. Defaults to 8 when neither the agent nor
   * `defaultOptions.maxTurns` supplies a value.
   */
  maxTurns?: number;

  /**
   * Listener invoked for each token-level delta emitted while the
   * model writes its response. Setting this switches the dispatch
   * from `generateText` to `streamText` under the hood; the
   * destination still returns a consolidated {@link AgentResult}
   * once the stream drains, so downstream pipeline ops are
   * unaffected.
   *
   * Use for live UI updates (SSE, WebSocket, console "type-out"
   * effect). For coarse observability (tool calls, step finishes,
   * total usage), subscribe to the `route:<id>:agent:*` events on
   * the context bus instead; those fire whether or not `onDelta`
   * is set.
   *
   * Listener errors are caught and logged, never propagate into the
   * dispatch. Async listeners are awaited so back-pressure on a slow
   * consumer flows back into the stream.
   *
   * Per-agent only; not part of `defaultOptions` because delta sinks
   * are typically request-scoped (e.g. a per-connection SSE channel).
   */
  onDelta?: AgentDeltaListener;
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
 * Summary of one tool invocation made during an agent dispatch.
 * Captured for post-dispatch programmatic assertions: a downstream
 * `.process()` step can inspect `AgentResult.toolCalls` to verify
 * the agent called what it was supposed to (e.g. "must have called
 * `replyEmail` before finishing"), and fail or escalate when it
 * didn't.
 *
 * For real-time observability use the context-bus events
 * (`route:<id>:agent:tool:invoked` / `result` / `error`) instead;
 * this summary is for synchronous post-hoc checks.
 *
 * @experimental
 */
export interface AgentToolCallSummary {
  /** Stable id assigned by the SDK to correlate invoked → result. */
  toolCallId: string;
  /** Name of the tool the model called. */
  toolName: string;
  /** Validated input passed to the handler. */
  input: unknown;
  /** Handler return value. Undefined when the call errored. */
  output?: unknown;
  /** Thrown value (or `RoutecraftError`). Undefined when the call succeeded. */
  error?: unknown;
}

/**
 * Result produced by an agent destination. Body of the exchange is replaced
 * with this shape after the agent runs.
 *
 * @experimental
 */
export interface AgentResult {
  /**
   * Raw text the model emitted as its final response. Always
   * populated. When an `output` schema is set, this is the JSON
   * string the model produced (which `output` exposes as the parsed,
   * typed value); without an output schema, this is the conversational
   * answer.
   */
  text: string;
  /**
   * Parsed structured output. Populated **only** when an `output`
   * schema was supplied on `AgentOptions` and the model produced a
   * value matching that schema. With an output schema set, this is
   * the canonical typed result; `text` carries the same data as a
   * raw JSON string. Without an output schema, this field is
   * undefined.
   */
  output?: unknown;
  /**
   * Concatenated reasoning text from the provider (Anthropic extended
   * thinking, OpenAI o1, etc.) when one was emitted. Useful for
   * debugging and audit; most consumers ignore it.
   */
  reasoning?: string;
  /**
   * Token usage when reported by the provider. Most providers fill
   * `inputTokens` + `outputTokens`; some also fill `totalTokens`.
   */
  usage?: LlmUsage;
  /**
   * Flat summary of every tool the agent called during the dispatch,
   * in invocation order. Empty (or absent) when the agent ran without
   * invoking any tools.
   *
   * Consume in a post-dispatch `.process()` step to assert on agent
   * behaviour and fail / escalate the route when the agent didn't do
   * what was expected:
   *
   * ```ts
   * .to(agent({ tools: tools(["replyEmail"]) }))
   * .error((err, ex, forward) => forward("escalate", ex.body))
   * .process((ex) => {
   *   const r = ex.body as AgentResult;
   *   const replied = r.toolCalls?.some(
   *     c => c.toolName === "replyEmail" && !c.error,
   *   );
   *   if (!replied) throw new Error("Agent did not reply via tool");
   *   return r;
   * })
   * ```
   *
   * For real-time observability subscribe to the context-bus events
   * `route:<id>:agent:tool:invoked` / `:result` / `:error`. This
   * summary is the synchronous post-hoc view of the same calls.
   */
  toolCalls?: AgentToolCallSummary[];
}
