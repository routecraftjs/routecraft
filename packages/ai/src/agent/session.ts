import type { CraftContext, Exchange } from "@routecraft/routecraft";
import { callLlm } from "../llm/providers/index.ts";
import {
  resolveModel,
  resolvePrompt,
  resolveUserPromptDefault,
} from "../llm/shared.ts";
import type { LlmModelConfig, LlmResult } from "../llm/types.ts";
import { toAiOutputSpec } from "../llm/structured-output.ts";
import { buildVercelTools } from "./tool-bridge.ts";
import type { ResolvedTool } from "./tools/selection.ts";
import type {
  AgentOptions,
  AgentRegisteredOptions,
  AgentResult,
} from "./types.ts";

/** Default sampling settings; aligned with the LLM destination defaults. */
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_MAX_STEPS = 8;

/**
 * Resolved agent inputs ready for dispatch. Computed once by the
 * destination's `send()` method (after merging `defaultOptions`,
 * resolving the tool selection, and deriving the user prompt) and
 * passed to the session constructor.
 *
 * @internal
 */
export interface AgentSessionInput {
  /** Agent options after merging with `defaultOptions`. `model` resolved. */
  readonly options: AgentOptions | AgentRegisteredOptions;
  /** Provider config for the resolved model. */
  readonly modelConfig: LlmModelConfig;
  /** Provider-specific model name (after `parseProviderModel`). */
  readonly modelName: string;
  /** Resolved tool list (empty when the agent has no tools). */
  readonly tools: ResolvedTool[];
  /** Final user prompt for this dispatch. */
  readonly user: string;
  /** Final system prompt for this dispatch. */
  readonly system: string;
  /** Optional context reference passed to tool handlers. */
  readonly context: CraftContext | undefined;
}

/**
 * Internal session that drives one agent dispatch. Encapsulates the
 * resolved tools + initial messages + provider config so the dispatch
 * path is structured around discrete units of work.
 *
 * Today only the synchronous path (`runUntilDone()`) is implemented —
 * it calls `generateText` once with the full tool list and lets the
 * Vercel AI SDK handle the multi-step tool-calling loop internally.
 *
 * The session boundary exists so two follow-ups layer on without
 * rearchitecting:
 *
 * - **Streaming** (#257) adds `runStream()` which calls `streamText`
 *   with the same setup and returns an `AsyncIterable<AgentEvent>`.
 * - **Durable agents** (#258) checkpoints the running messages array
 *   between tool-call steps and lets a tool handler throw
 *   `SuspendError` to pause the loop.
 *
 * @internal
 */
export class AgentSession {
  constructor(public readonly input: AgentSessionInput) {}

  /**
   * Run the synchronous tool-calling loop until the model emits a
   * final text response (or `stopWhen` fires). Returns the
   * consolidated `AgentResult`.
   */
  async runUntilDone(abortSignal: AbortSignal): Promise<AgentResult> {
    const { options, modelConfig, modelName, tools, user, system, context } =
      this.input;

    const vercelTools = await buildVercelTools(tools, context, abortSignal);
    const stopWhen = await buildStopWhen(options.maxSteps ?? DEFAULT_MAX_STEPS);
    const output =
      options.output !== undefined ? toAiOutputSpec(options.output) : undefined;

    const result = await callLlm({
      config: modelConfig,
      modelId: modelName,
      options: {
        temperature: DEFAULT_TEMPERATURE,
        maxTokens: DEFAULT_MAX_TOKENS,
      },
      system,
      user,
      ...(output !== undefined ? { output } : {}),
      ...(Object.keys(vercelTools).length > 0
        ? { tools: vercelTools, stopWhen }
        : {}),
    });

    return toAgentResult(result);
  }
}

async function buildStopWhen(maxSteps: number): Promise<unknown> {
  const { stepCountIs } = await import("ai");
  return stepCountIs(maxSteps);
}

function toAgentResult(result: LlmResult): AgentResult {
  const out: AgentResult = { text: result.text };
  if (result.output !== undefined) out.output = result.output;
  if (result.reasoning !== undefined) out.reasoning = result.reasoning;
  if (result.usage) out.usage = result.usage;
  return out;
}

/**
 * Build the user prompt for an agent dispatch from the merged options
 * and the incoming exchange. Uses the agent's `user:` resolver when
 * present, otherwise derives a default from `exchange.body`
 * (matches the existing LLM destination behaviour).
 *
 * @internal
 */
export function buildUserPrompt(
  options: AgentOptions | AgentRegisteredOptions,
  exchange: Exchange<unknown>,
): string {
  return options.user !== undefined
    ? resolvePrompt(options.user, exchange)
    : resolveUserPromptDefault(exchange);
}

/**
 * Resolve the model id and provider config from the merged options
 * and current context. Throws RC5003 with a clear message if no model
 * is available (neither agent option nor `defaultOptions.model`).
 *
 * @internal
 */
export function buildModel(
  options: AgentOptions | AgentRegisteredOptions,
  context: CraftContext | undefined,
): { config: LlmModelConfig; modelName: string } {
  if (options.model === undefined) {
    // Caller (destination) is expected to throw before this. Defensive
    // path; re-raise here to avoid producing a malformed session.
    throw new Error(
      `AgentSession: no "model" supplied. Set "model" on the agent or via agentPlugin({ defaultOptions: { model } }).`,
    );
  }
  return resolveModel(options.model, context);
}
