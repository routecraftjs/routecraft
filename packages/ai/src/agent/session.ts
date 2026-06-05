import {
  HeadersKeys,
  rcError,
  type CraftContext,
  type EventName,
  type Exchange,
} from "@routecraft/routecraft";
import { isBlockLoaderCall, summariseBlockLoads } from "../block/resolve.ts";
import { callLlm, streamLlm } from "../llm/providers/index.ts";
import { resolvePrompt, resolveUserPromptDefault } from "../llm/shared.ts";
import type {
  LlmModelConfig,
  LlmResult,
  LlmToolCallSummary,
} from "../llm/types.ts";
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
  // The framework runtime sets `routecraft.correlation_id` on every
  // exchange that flows through a real route. Synthetic exchanges
  // (mostly tests) may lack it; fall back to the exchange id so the
  // emitted events still carry a stable, non-empty `correlationId`.
  const corr = exchange.headers[HeadersKeys.CORRELATION_ID];
  return {
    exchangeId: exchange.id,
    correlationId: typeof corr === "string" ? corr : exchange.id,
    routeId,
  };
}

/** Default sampling settings; aligned with the LLM destination defaults. */
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_MAX_TURNS = 20;

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
  /**
   * Full `providerId:modelName` identifier this dispatch resolved to
   * (e.g. `anthropic:claude-opus-4-7`). Emitted on the agent lifecycle
   * events so observability consumers can show the model per run.
   */
  readonly model: string;
  /**
   * Registered agent id when dispatched by name (`agent("id")`),
   * undefined for inline agents (which are identified by their route).
   * Emitted on the agent lifecycle events so the TUI can attribute a
   * run to a named agent rather than only the dispatching route.
   */
  readonly agentName?: string;
  /** Resolved tool list (empty when the agent has no tools). */
  readonly tools: ResolvedTool[];
  /** Final user prompt for this dispatch. */
  readonly user: string;
  /** Final system prompt for this dispatch. */
  readonly system: string;
  /** Optional context reference passed to tool handlers. */
  readonly context: CraftContext | undefined;
  /**
   * Source exchange that triggered this dispatch. Forwarded to the
   * `validate` hook (`ctx.exchange`) so validators can correlate the
   * model's output with request-scoped state (headers, principal,
   * correlation id) when deciding whether to accept or retry.
   */
  readonly exchange: Exchange<unknown>;
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
   *
   * When `validate` is set, runs the validation retry loop: every
   * call's result is fed to the validator, and a string return
   * triggers another model call with the validator message injected
   * as a corrective user turn. Retries share the `maxTurns` budget;
   * exhausting it with `validate` still rejecting fails the dispatch
   * with `RC5003`.
   */
  async runUntilDone(abortSignal: AbortSignal): Promise<AgentResult> {
    return this.runWithValidation(abortSignal, undefined);
  }

  /**
   * Run the streaming tool-calling loop. Same shape as
   * {@link AgentSession.runUntilDone}, but the dispatch goes through
   * `streamText`: each normalised token-level delta is forwarded to
   * `onDelta` while the loop runs, and the consolidated
   * {@link AgentResult} is returned once the stream drains. Coarse
   * decision events (tool-call, tool-result, finished,
   * error) flow on the context bus regardless of whether `onDelta`
   * is set; see `route:<id>:agent:*` events.
   *
   * `validate` retries follow the same loop as the sync path: each
   * retry restarts the stream with the prior history + the validator
   * message, and `onDelta` continues to fire across retries.
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
    return this.runWithValidation(abortSignal, onDelta);
  }

  /**
   * Shared dispatch path used by both `runUntilDone` and `runStream`.
   * Calls the model once, runs `validate` (when set), and either
   * returns the accepted result or loops with a corrective user
   * message until the validator accepts or `maxTurns` is exhausted.
   *
   * The cumulative `toolCalls` from every retry land on the final
   * `AgentResult.toolCalls`, so post-dispatch assertions like
   * "must have called send_email" see the agent's full tool history
   * (not just the last call's).
   *
   * @internal
   */
  private async runWithValidation(
    abortSignal: AbortSignal,
    onDelta: AgentDeltaListener | undefined,
  ): Promise<AgentResult> {
    const { options, exchange } = this.input;
    const validate = options.validate;
    const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.emitStarted(maxTurns);
    const prepared = await this.prepare(abortSignal);

    let turnsUsed = 0;
    let currentUser: string | unknown[] = this.input.user;
    let lastValidatorMsg: string | undefined;
    const accumulatedToolCalls: LlmToolCallSummary[] = [];

    try {
      while (true) {
        const remaining = maxTurns - turnsUsed;
        if (remaining <= 0) {
          throw rcError("RC5003", undefined, {
            message: lastValidatorMsg
              ? `agent: maxTurns (${maxTurns}) reached while "validate" was still rejecting; last validator message: "${lastValidatorMsg}"`
              : `agent: maxTurns (${maxTurns}) reached.`,
          });
        }
        const result = await callOnce(
          prepared,
          currentUser,
          remaining,
          abortSignal,
          onDelta,
        );
        turnsUsed += result.stepsCount ?? 1;
        if (result.toolCalls && result.toolCalls.length > 0) {
          accumulatedToolCalls.push(...result.toolCalls);
        }
        if (!validate) {
          this.emitFinished(result);
          return toAgentResult(result, accumulatedToolCalls);
        }
        const verdict = await Promise.resolve(
          validate(toAgentResult(result, accumulatedToolCalls), {
            exchange,
            turnsUsed,
          }),
        );
        if (verdict === undefined || verdict === null) {
          this.emitFinished(result);
          return toAgentResult(result, accumulatedToolCalls);
        }
        if (typeof verdict !== "string" || verdict.trim() === "") {
          throw rcError("RC5003", undefined, {
            message: `agent: "validate" returned a non-string, non-void value (${typeof verdict}). Return void to accept, a non-empty string to retry.`,
          });
        }
        lastValidatorMsg = verdict;
        currentUser = buildRetryPrompt(
          this.input.user,
          currentUser,
          result,
          verdict,
        );
      }
    } catch (err) {
      this.emitError(err);
      throw err;
    }
  }

  /**
   * Emit `route:<id>:agent:started` on the context bus at the start of
   * a dispatch. Carries the agent identity, resolved model, tool names,
   * and turn budget so observability consumers (the TUI) can show that
   * an agent executed, with what model and tools, even if the run later
   * fails mid-flight.
   *
   * @internal
   */
  private emitStarted(maxTurns: number): void {
    const id = this.input.dispatchIdentity;
    const ctx = this.input.context;
    if (!id || !ctx) return;
    ctx.emit(`route:${id.routeId}:agent:started` as EventName, {
      routeId: id.routeId,
      exchangeId: id.exchangeId,
      correlationId: id.correlationId,
      ...(this.input.agentName !== undefined && {
        agentName: this.input.agentName,
      }),
      model: this.input.model,
      toolNames: this.input.tools.map((t) => t.name),
      maxTurns,
    });
  }

  /**
   * Emit `route:<id>:agent:finished` on the context bus once the
   * dispatch returns a consolidated result. Carries the agent identity,
   * model, finish reason and total token usage so observability
   * consumers can wire dashboards / metrics / billing without
   * subscribing to per-token deltas.
   *
   * @internal
   */
  private emitFinished(result: LlmResult): void {
    const id = this.input.dispatchIdentity;
    const ctx = this.input.context;
    if (!id || !ctx) return;
    // Both runGenerate (sync) and runStreamGenerate (after awaiting
    // the SDK Promise) populate `result.finishReason` as a normalised
    // string. Falls back to "unknown" only when the provider didn't
    // report one.
    const finishReason = result.finishReason ?? "unknown";
    ctx.emit(`route:${id.routeId}:agent:finished` as EventName, {
      routeId: id.routeId,
      exchangeId: id.exchangeId,
      correlationId: id.correlationId,
      ...(this.input.agentName !== undefined && {
        agentName: this.input.agentName,
      }),
      model: this.input.model,
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
      ...(this.input.agentName !== undefined && {
        agentName: this.input.agentName,
      }),
      model: this.input.model,
      error: err,
    });
  }

  /**
   * Shared setup invoked once per dispatch (not per validate retry):
   * builds the Vercel tool map and resolves the structured-output
   * spec. `stopWhen` is built per call inside the validation loop
   * so each call gets the *remaining* turn budget rather than the
   * full `maxTurns`.
   *
   * @internal
   */
  private async prepare(abortSignal: AbortSignal): Promise<{
    modelConfig: LlmModelConfig;
    modelName: string;
    system: string;
    output?: unknown;
    vercelTools: Record<string, unknown>;
  }> {
    const {
      options,
      modelConfig,
      modelName,
      tools,
      system,
      context,
      exchange,
      dispatchIdentity,
    } = this.input;
    const vercelTools = await buildVercelTools(
      tools,
      context,
      abortSignal,
      dispatchIdentity,
      exchange.principal,
    );
    const base = { modelConfig, modelName, system, vercelTools };
    return options.output !== undefined
      ? { ...base, output: toAiOutputSpec(options.output) }
      : base;
  }
}

interface PreparedSession {
  modelConfig: LlmModelConfig;
  modelName: string;
  system: string;
  output?: unknown;
  vercelTools: Record<string, unknown>;
}

/**
 * One model call. Builds `stopWhen: stepCountIs(remainingTurns)` so a
 * later validate-retry consumes turns from the same shared budget,
 * then dispatches via `callLlm` (sync) or `streamLlm` (when an
 * `onDelta` listener is attached).
 *
 * @internal
 */
async function callOnce(
  prepared: PreparedSession,
  user: string | unknown[],
  remainingTurns: number,
  abortSignal: AbortSignal,
  onDelta: AgentDeltaListener | undefined,
): Promise<LlmResult> {
  const toolExtras =
    Object.keys(prepared.vercelTools).length > 0
      ? {
          tools: prepared.vercelTools,
          stopWhen: await buildStopWhen(remainingTurns),
        }
      : {};
  const base = {
    config: prepared.modelConfig,
    modelId: prepared.modelName,
    options: {
      temperature: DEFAULT_TEMPERATURE,
      maxTokens: DEFAULT_MAX_TOKENS,
    },
    system: prepared.system,
    user,
    abortSignal,
    ...(prepared.output !== undefined ? { output: prepared.output } : {}),
    ...toolExtras,
  };
  return onDelta ? streamLlm({ ...base, onDelta }) : callLlm(base);
}

async function buildStopWhen(maxTurns: number): Promise<unknown> {
  const { stepCountIs } = await import("ai");
  return stepCountIs(maxTurns);
}

/**
 * Build the prompt array for a `validate`-triggered retry.
 *
 * Concatenates: prior user-side messages (the initial user prompt
 * promoted to a `{ role: "user" }` message on the first retry, or
 * the array carried over from a prior retry), the SDK's response
 * messages from the just-finished call (assistant text + any tool
 * messages), and a fresh user-role corrective `"Validator: <msg>"`.
 *
 * @internal
 */
function buildRetryPrompt(
  initialUser: string,
  currentUser: string | unknown[],
  lastResult: LlmResult,
  validatorMsg: string,
): unknown[] {
  const userMsgs: unknown[] =
    typeof currentUser === "string"
      ? [{ role: "user", content: initialUser }]
      : currentUser;
  const responseMessages = lastResult.responseMessages ?? [];
  return [
    ...userMsgs,
    ...responseMessages,
    { role: "user", content: `Validator: ${validatorMsg}` },
  ];
}

function toAgentResult(
  result: LlmResult,
  accumulatedToolCalls: LlmToolCallSummary[],
): AgentResult {
  const out: AgentResult = { text: result.text };
  if (result.output !== undefined) out.output = result.output;
  if (result.reasoning !== undefined) out.reasoning = result.reasoning;
  if (result.usage) out.usage = result.usage;
  // Cumulative across all validate retries so post-dispatch assertions
  // like "must have called X" see the agent's full tool history rather
  // than only the last call's. Synthetic block-loader invocations are
  // partitioned out into `blocksLoaded` so user-tool assertions stay
  // clean.
  const userCalls: LlmToolCallSummary[] = [];
  const blockCalls: LlmToolCallSummary[] = [];
  for (const call of accumulatedToolCalls) {
    if (isBlockLoaderCall(call.toolName)) {
      blockCalls.push(call);
    } else {
      userCalls.push(call);
    }
  }
  if (userCalls.length > 0) out.toolCalls = userCalls;
  if (blockCalls.length > 0) out.blocksLoaded = summariseBlockLoads(blockCalls);
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
