import {
  HeadersKeys,
  type CraftContext,
  type EventName,
  type Exchange,
} from "@routecraft/routecraft";
import { callLlm, streamLlm } from "../llm/providers/index.ts";
import { resolvePrompt, resolveUserPromptDefault } from "../llm/shared.ts";
import type { LlmModelConfig, LlmResult } from "../llm/types.ts";
import { toAiOutputSpec } from "../llm/structured-output.ts";
import type { AgentDeltaListener } from "./events.ts";
import { buildVercelTools } from "./tool-bridge.ts";
import type { ResolvedTool } from "./tools/selection.ts";
import type {
  AgentOptions,
  AgentRegisteredOptions,
  AgentResult,
} from "./types.ts";

/**
 * Identity of the exchange driving the current dispatch. Used to emit
 * `route:<routeId>:agent:*` events on the context bus with stable
 * `exchangeId` / `correlationId` / `routeId` fields.
 *
 * @internal
 */
export interface AgentDispatchIdentity {
  exchangeId: string;
  correlationId: string;
  routeId: string;
}

/**
 * Extract the dispatch identity from an exchange. Returns `undefined`
 * for synthetic exchanges that have no route binding (mostly tests).
 *
 * @internal
 */
export function dispatchIdentityFrom(
  exchange: Exchange<unknown>,
  routeId: string | undefined,
): AgentDispatchIdentity | undefined {
  if (routeId === undefined) return undefined;
  return {
    exchangeId: exchange.id,
    correlationId: exchange.headers[HeadersKeys.CORRELATION_ID] as string,
    routeId,
  };
}

/** Default sampling settings; aligned with the LLM destination defaults. */
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_MAX_TURNS = 8;

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
  /**
   * Dispatch identity used to emit `route:<routeId>:agent:*` events
   * on the context bus. Undefined for synthetic exchanges with no
   * route binding.
   */
  readonly dispatchIdentity: AgentDispatchIdentity | undefined;
}

/**
 * Internal session that drives one agent dispatch. Encapsulates the
 * resolved tools + initial messages + provider config so the dispatch
 * path is structured around discrete units of work.
 *
 * Two execution paths are exposed:
 *
 * - {@link AgentSession.runUntilDone} calls `generateText` once with
 *   the full tool list and lets the Vercel AI SDK handle the
 *   multi-step tool-calling loop internally. Returns the consolidated
 *   {@link AgentResult} when the loop terminates.
 * - {@link AgentSession.runStream} calls `streamText` with the same
 *   setup, forwards every normalised event through the user-supplied
 *   listener, and returns the same consolidated {@link AgentResult}
 *   once the stream drains.
 *
 * Future hook (durable agents, #258): checkpoints the running messages
 * array between tool-call steps and lets a tool handler throw
 * `SuspendError` to pause the loop.
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
    const { modelConfig, modelName, system, user, output, toolExtras } =
      await this.prepare(abortSignal);
    try {
      const result = await callLlm({
        config: modelConfig,
        modelId: modelName,
        options: {
          temperature: DEFAULT_TEMPERATURE,
          maxTokens: DEFAULT_MAX_TOKENS,
        },
        system,
        user,
        abortSignal,
        ...(output !== undefined ? { output } : {}),
        ...toolExtras,
      });
      this.emitFinished(result);
      return toAgentResult(result);
    } catch (err) {
      this.emitError(err);
      throw err;
    }
  }

  /**
   * Run the streaming tool-calling loop. Same setup as
   * {@link AgentSession.runUntilDone}, but the dispatch goes through
   * `streamText`: each normalised token-level delta is forwarded to
   * `onDelta` while the loop runs, and the consolidated
   * {@link AgentResult} is returned once the stream drains. Coarse
   * decision events (tool-call, tool-result, turn-finished, finished,
   * error) flow on the context bus regardless of whether `onDelta`
   * is set; see `route:<id>:agent:*` events.
   *
   * Listener errors are caught and logged inside the LLM-provider
   * layer; they never abort the dispatch. Stream-level errors
   * (provider failure, network error) are surfaced both as an
   * `agent:error` context event AND propagate by rejecting this
   * promise, so callers handle failure exactly like the sync path.
   */
  async runStream(
    abortSignal: AbortSignal,
    onDelta: AgentDeltaListener,
  ): Promise<AgentResult> {
    const { modelConfig, modelName, system, user, output, toolExtras } =
      await this.prepare(abortSignal);
    try {
      const result = await streamLlm({
        config: modelConfig,
        modelId: modelName,
        options: {
          temperature: DEFAULT_TEMPERATURE,
          maxTokens: DEFAULT_MAX_TOKENS,
        },
        system,
        user,
        abortSignal,
        onDelta,
        ...(output !== undefined ? { output } : {}),
        ...toolExtras,
      });
      this.emitFinished(result);
      return toAgentResult(result);
    } catch (err) {
      this.emitError(err);
      throw err;
    }
  }

  /**
   * Emit `route:<id>:agent:finished` on the context bus once the
   * dispatch returns a consolidated result. Carries finish reason
   * and total token usage so observability consumers can wire
   * dashboards / metrics / billing without subscribing to per-token
   * deltas.
   *
   * @internal
   */
  private emitFinished(result: LlmResult): void {
    const id = this.input.dispatchIdentity;
    const ctx = this.input.context;
    if (!id || !ctx) return;
    const finishReason =
      readString(
        (result.raw as Record<string, unknown> | undefined) ?? {},
        "finishReason",
      ) ?? "unknown";
    ctx.emit(`route:${id.routeId}:agent:finished` as EventName, {
      routeId: id.routeId,
      exchangeId: id.exchangeId,
      correlationId: id.correlationId,
      finishReason,
      ...(result.usage?.inputTokens !== undefined && {
        inputTokens: result.usage.inputTokens,
      }),
      ...(result.usage?.outputTokens !== undefined && {
        outputTokens: result.usage.outputTokens,
      }),
      ...(result.usage?.totalTokens !== undefined && {
        totalTokens: result.usage.totalTokens,
      }),
    });
  }

  /**
   * Emit `route:<id>:agent:error` on the context bus when the
   * dispatch promise rejects (provider failure, transport error, an
   * unhandled tool throw cascading through the SDK). The error
   * still propagates by rethrow; this just gives observability
   * subscribers a chance to record the failure without wrapping
   * every dispatch site.
   *
   * @internal
   */
  private emitError(err: unknown): void {
    const id = this.input.dispatchIdentity;
    const ctx = this.input.context;
    if (!id || !ctx) return;
    ctx.emit(`route:${id.routeId}:agent:error` as EventName, {
      routeId: id.routeId,
      exchangeId: id.exchangeId,
      correlationId: id.correlationId,
      error: err,
    });
  }

  /**
   * Shared setup for both dispatch paths: build the Vercel tool map,
   * resolve the structured-output spec, and compute the
   * tools/stopWhen extras. Pulled out so `runUntilDone` and
   * `runStream` differ only in which underlying SDK call they make.
   *
   * @internal
   */
  private async prepare(abortSignal: AbortSignal): Promise<{
    modelConfig: LlmModelConfig;
    modelName: string;
    system: string;
    user: string;
    output?: unknown;
    toolExtras:
      | { tools: Record<string, unknown>; stopWhen: unknown }
      | Record<string, never>;
  }> {
    const {
      options,
      modelConfig,
      modelName,
      tools,
      user,
      system,
      context,
      dispatchIdentity,
    } = this.input;
    const vercelTools = await buildVercelTools(
      tools,
      context,
      abortSignal,
      dispatchIdentity,
    );
    const toolExtras =
      Object.keys(vercelTools).length > 0
        ? {
            tools: vercelTools,
            stopWhen: await buildStopWhen(
              options.maxTurns ?? DEFAULT_MAX_TURNS,
            ),
          }
        : {};
    const base = { modelConfig, modelName, system, user, toolExtras };
    return options.output !== undefined
      ? { ...base, output: toAiOutputSpec(options.output) }
      : base;
  }
}

async function buildStopWhen(maxTurns: number): Promise<unknown> {
  const { stepCountIs } = await import("ai");
  return stepCountIs(maxTurns);
}

function readString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
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
