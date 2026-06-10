import type { Exchange, Principal } from "@routecraft/routecraft";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  AgentBlockLoadSummary,
  BlockBody,
  Blocks,
} from "../block/types.ts";
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
 */
export type AgentUserPromptSource = LlmPromptSource;

/**
 * Custom renderer for the agent's `## Caller` section. Receives the
 * request's principal (`undefined` when the request is unauthenticated)
 * and the incoming exchange, and returns the markdown to append to the
 * system prompt. Return an empty string to append nothing.
 *
 * Used as the function form of `AgentOptions.principal` when an author
 * wants full control over the wording or which fields are shown. A custom
 * renderer owns its own escaping and MUST NOT surface `claims`,
 * `userinfoClaims`, or anything bearer-derived (see
 * `.standards/security.md` § 3a).
 */
export type AgentPrincipalRenderer = (
  principal: Principal | undefined,
  exchange: Exchange<unknown>,
) => string;

/**
 * Context-level defaults applied to any agent that doesn't override them.
 * Set via `agentPlugin({ defaultOptions: {...} })`. Per-agent values
 * win over these.
 *
 * Mirrors the `llmPlugin({ defaultOptions })` shape so the same mental
 * model carries across.
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

  /**
   * Default caller-awareness setting applied to agents that omit
   * `principal`. Same shape as {@link AgentOptions.principal} (`true` for
   * the built-in `## Caller` block, or a `(principal, exchange) => string`
   * renderer). Lets a context opt every agent into caller-awareness once;
   * a per-agent `principal` (including `false`) overrides it.
   */
  principal?: boolean | AgentPrincipalRenderer;

  /**
   * Default record of system-context blocks applied to every agent.
   * See {@link AgentOptions.blocks} for the primitive's semantics.
   *
   * Merge semantics with the per-agent `blocks` field differ from how
   * `tools` merges: defaults are not replaced wholesale. The per-agent
   * record is merged on top by name, so a per-agent block whose key
   * matches a default replaces only that entry; non-colliding default
   * blocks still apply. Setting a per-agent block to `false` removes
   * the matching default for that agent. This lets a context install
   * shared blocks once (identity, tenant config, memory) and have
   * individual agents add, replace, or remove specific entries.
   *
   * When two `agentPlugin` installs each supply `defaultOptions.blocks`,
   * the records are merged additively by name. A name set in both
   * installs throws `RC5003` so the framework never silently picks
   * one over the other.
   *
   * Unlike the per-agent {@link AgentOptions.blocks} field, defaults
   * cannot carry the `false` removal sentinel: defaults cannot sensibly
   * remove themselves. The top-level value type therefore excludes
   * `false` (`BlockBody` or a nested {@link Blocks} group); a nested
   * group's value type still permits `false` at the type level (it is
   * the `Blocks` alias), but a `false` at any nesting level is rejected
   * at plugin construction with RC5003, so the runtime contract is
   * "no `false` anywhere in defaults".
   */
  blocks?: { [name: string]: BlockBody | Blocks };
}

/**
 * Options for the agent destination when defined inline in a route.
 *
 * Identity and description for inline agents live on the enclosing route:
 * `.id()` is the agent's callable identity and `.description()` is its
 * human-readable description. `AgentOptions` only carries LLM-specific
 * config.
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
   * Record of contributions to the agent's system context, keyed by
   * block name. Each block is either always injected
   * (`mode: "inject"`) or progressively disclosed
   * (`mode: "progressive"`), and may carry a static string or a
   * function that resolves the content at dispatch time. See
   * {@link Blocks}.
   *
   * Inject blocks are concatenated onto the agent's `system` prompt
   * as `## <name>\n\n<content>` in insertion order (defaults first,
   * then per-agent entries). Progressive blocks are exposed as
   * synthetic `_block_load_<name>` tools the model can invoke on
   * demand, matching Claude Code's default progressive-disclosure
   * behaviour.
   *
   * Use `skills({ source })` from `@routecraft/ai` to load markdown
   * skills as blocks; or define inline blocks for identity, memory,
   * tenant config, or any other system-prompt contribution. Set a
   * block to `false` to remove a matching entry inherited from
   * `agentPlugin({ defaultOptions: { blocks } })`.
   */
  blocks?: Blocks;

  /**
   * Append a `## Caller` section to the system prompt describing who
   * triggered the request, so the model can address the caller and knows
   * when no one is authenticated.
   *
   * - `true` -- append the built-in block: the caller's identity (`name`,
   *   `email`, `subject`) and `roles` derived from `exchange.principal`,
   *   or an explicit "not authenticated" note when no principal is
   *   present.
   * - a function `(principal, exchange) => string` -- append the markdown
   *   it returns (return `""` to append nothing), for full control over
   *   the wording and which fields are shown. See
   *   {@link AgentPrincipalRenderer}.
   * - `false` / omitted -- append nothing. Opt-in default, so existing
   *   agents see no change to their prompt or token usage.
   *
   * The section is appended after `blocks`, so the author's own `system`
   * prompt and any block content come first.
   *
   * The built-in block surfaces only loggable identity fields (see
   * `.standards/security.md` § 3); scopes, `claims`, `userinfoClaims`, and
   * the bearer token are never injected, and interpolated values have
   * newlines collapsed so a subject-controlled field cannot forge prompt
   * structure. A custom renderer owns its own escaping. Authorization is
   * still enforced by `.authorize()` and guards; this block is
   * informational context for the model, not an authorization gate.
   */
  principal?: boolean | AgentPrincipalRenderer;

  /**
   * Cap on tool-calling turns for the Vercel AI SDK loop. Each turn
   * is one model call (which may emit any number of tool calls) plus
   * the resulting tool results. Resolves to `stopWhen: stepCountIs(n)`
   * at dispatch. Defaults to 20 when neither the agent nor
   * `defaultOptions.maxTurns` supplies a value.
   *
   * `validate` retries share this same budget: a corrective turn
   * triggered by `validate` consumes one turn just like any other
   * model step.
   */
  maxTurns?: number;

  /**
   * Pre-finish validator. Invoked after the model emits a final text
   * response (and after any `output` schema parsing). Returning
   * `void` accepts the result and the dispatch resolves with it.
   * Returning a string sends the agent back for another turn with
   * the string injected as a corrective user message
   * (`"Validator: <msg>"`); the model sees the prior assistant
   * messages and tool history, so it can self-correct.
   *
   * Throwing inside `validate` fails the dispatch with the thrown
   * error; use this when the violation is unrecoverable.
   *
   * Validate retries share the `maxTurns` budget. When the budget is
   * exhausted while `validate` is still rejecting, the dispatch
   * fails with `RC5003` carrying the last validator message.
   *
   * Per-agent only; not part of `defaultOptions` because what
   * "valid" means is intrinsic to a specific agent's job.
   *
   * @example
   * ```ts
   * agent({
   *   model: "anthropic:claude-sonnet-4-6",
   *   system: "...",
   *   validate: (result) => {
   *     if (!result.toolCalls?.some(t => t.toolName === "send_email")) {
   *       return "You must send an email before finishing.";
   *     }
   *   },
   * });
   * ```
   */
  validate?: (
    result: AgentResult,
    ctx: { exchange: Exchange<unknown>; turnsUsed: number },
  ) => void | string | Promise<void | string>;

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
   * total usage), subscribe to the `route:agent:*` events on
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
 * (`route:agent:tool:invoked` / `result` / `error`) instead;
 * this summary is for synchronous post-hoc checks.
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
   * `route:agent:tool:invoked` / `:result` / `:error`. This
   * summary is the synchronous post-hoc view of the same calls.
   *
   * Synthetic block-loader calls (`_block_load_<name>`) are excluded
   * from this list and surface separately on {@link AgentResult.blocksLoaded}
   * so post-dispatch assertions on the agent's user-tool usage are
   * not polluted by framework bookkeeping.
   */
  toolCalls?: AgentToolCallSummary[];

  /**
   * Summary of every progressive-mode block the model loaded during
   * the dispatch, in invocation order. Empty (or absent) when no
   * progressive blocks were loaded.
   *
   * Inject-mode blocks are never represented here because they are
   * always concatenated into the system prompt; only on-demand loads
   * appear in this list.
   */
  blocksLoaded?: AgentBlockLoadSummary[];
}
