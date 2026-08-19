import {
  HeadersKeys,
  SuspendSignal,
  isSuspendSignal,
  rcError,
  type CraftContext,
  type Exchange,
} from "@routecraft/routecraft";
import { isBlockLoaderCall, summariseBlockLoads } from "../block/resolve.ts";
import { callLlm, streamLlm } from "../llm/providers/index.ts";
import { resolvePrompt, resolveUserPromptDefault } from "../llm/shared.ts";
import type {
  LlmModelConfig,
  LlmResult,
  LlmToolCallSummary,
  LlmUsage,
} from "../llm/types.ts";
import { toAiOutputSpec } from "../llm/structured-output.ts";
import type { AgentDeltaListener } from "./events.ts";
import { buildVercelTools, type AgentSuspensionBridge } from "./tool-bridge.ts";
import {
  SIBLING_SUSPENDED_MESSAGE,
  pickWinningSignal,
  replaceToolResultOutput,
  type AgentStepState,
  type AgentSuspendSignalRecord,
  type ThreadMessage,
} from "./suspension-state.ts";
import { addUsage } from "../llm/providers/llm-utils.ts";
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
   * route binding: a deliberate arm meaning "synthetic or test
   * dispatch", under which observability events are skipped and any
   * suspension signal is refused with AI1006 at the moment it is
   * raised (nothing is ever written).
   */
  readonly dispatchIdentity: AgentDispatchIdentity | undefined;
  /**
   * Durable-suspension wiring for this dispatch, present only when the
   * exchange is route-bound (so it can actually park). Carries the
   * suspension identity `ctx.suspend` / `ctx.suspension` are served from
   * and the agent identity persisted into `stepState`.
   */
  readonly suspension?: AgentSessionSuspension;
  /**
   * Mid-loop state to re-enter after a resume: the persisted messages
   * thread (with the suspended call's answer already swapped in) and the
   * turns the run had spent before it parked. A park is not a fresh
   * dispatch, so the `maxTurns` budget continues rather than resetting.
   */
  readonly resume?: AgentSessionResume;
}

/**
 * Suspension identity for one dispatch. See
 * {@link AgentSessionInput.suspension}.
 *
 * @internal
 */
export interface AgentSessionSuspension {
  /** Id the dispatching exchange would park as (or parked as). */
  readonly id: string;
  /** Mint the signed resume token for that id (lazily; may throw RC5052). */
  readonly mintToken: () => string;
  /**
   * Identity written into `stepState.agentId` and verified at
   * rehydration: the registered agent name, or the route id for inline
   * agents.
   */
  readonly agentId: string;
}

/**
 * Mid-loop state a resumed dispatch re-enters with. See
 * {@link AgentSessionInput.resume}.
 *
 * @internal
 */
export interface AgentSessionResume {
  readonly messages: readonly ThreadMessage[];
  readonly turnsUsed: number;
}

/**
 * The structured cause on an `AI1005` cancellation error: what the run had
 * spent when the abort discarded it, as typed fields rather than prose.
 *
 * Consumers read it off the error's `cause`:
 *
 * ```ts
 * if (isRcError(err, "AI1005") && err.cause instanceof AgentCancellationCause) {
 *   report(err.cause.turnsUsed, err.cause.usage);
 * }
 * ```
 */
export class AgentCancellationCause extends Error {
  /** Full model turns completed before the abort. */
  readonly turnsUsed: number;
  /** Token spend accumulated across the completed model calls, if any reported. */
  readonly usage?: LlmUsage;

  constructor(reason: unknown, turnsUsed: number, usage: LlmUsage | undefined) {
    super(
      reason instanceof Error
        ? reason.message
        : reason !== undefined && reason !== null
          ? String(reason)
          : "cancelled",
    );
    this.name = "AgentCancellationCause";
    this.turnsUsed = turnsUsed;
    if (usage) this.usage = usage;
  }
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
 * Durable suspension (#268/#269): a tool handler that returns
 * `ctx.suspend(...)`'s sentinel (or throws `SuspendError`) stops the loop
 * after its batch settles; the session persists the messages thread and
 * outstanding tool-call id as `stepState` and raises the core
 * `SuspendSignal`, which the hosting `.to()` / `.enrich()` step converts
 * into a park. A resumed dispatch re-enters through
 * {@link AgentSessionInput.resume} with the answer already swapped into
 * the thread.
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
   * is set; see `route:agent:*` events.
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

    // A resumed dispatch continues its own budget and its own thread: a
    // park is not a fresh dispatch. A run that resumes with the budget
    // already exhausted takes the ordinary max-turns path below.
    let turnsUsed = this.input.resume?.turnsUsed ?? 0;
    let currentUser: string | ThreadMessage[] = this.input.resume
      ? [...this.input.resume.messages]
      : this.input.user;
    let lastValidatorMsg: string | undefined;
    const accumulatedToolCalls: LlmToolCallSummary[] = [];
    let accumulatedUsage: LlmUsage | undefined;
    // Filled by the tool bridge when a handler suspends. Checked after
    // every model call: a non-empty batch means the loop is over and the
    // exchange parks.
    const signals: AgentSuspendSignalRecord[] = [];

    try {
      // Inside the try so a prepare failure (tool resolution, schema
      // resolution) still emits agent:error; otherwise the started event
      // would be orphaned and observability would show the run as
      // running forever.
      const prepared = await this.prepare(abortSignal, signals);
      while (true) {
        // Between-turn checkpoint: the cheap, always-correct place to
        // observe cancellation. The signal also rides into the model call
        // and every tool handler, so an abort mid-turn stops paying for
        // tokens rather than finishing the turn and discarding it.
        if (abortSignal.aborted) {
          throw this.cancelledError(
            abortSignal.reason,
            turnsUsed,
            accumulatedUsage,
          );
        }
        const remaining = maxTurns - turnsUsed;
        if (remaining <= 0) {
          throw rcError("RC5003", undefined, {
            message: lastValidatorMsg
              ? `agent: maxTurns (${maxTurns}) reached while "validate" was still rejecting; last validator message: "${lastValidatorMsg}"`
              : `agent: maxTurns (${maxTurns}) reached.`,
          });
        }
        let result: LlmResult;
        try {
          result = await callOnce(
            prepared,
            currentUser,
            remaining,
            abortSignal,
            onDelta,
            signals,
          );
        } catch (err) {
          // An aborted run surfaces as whatever the SDK threw on the way
          // down; report it as the one thing it is (a cancellation), with
          // the spend so far, rather than as a provider failure.
          if (abortSignal.aborted || isAbortLike(err)) {
            throw this.cancelledError(err, turnsUsed, accumulatedUsage);
          }
          throw err;
        }
        turnsUsed += result.stepsCount ?? 1;
        accumulatedUsage = addUsage(accumulatedUsage, result.usage);
        if (result.toolCalls && result.toolCalls.length > 0) {
          accumulatedToolCalls.push(...result.toolCalls);
        }
        if (signals.length > 0) {
          throw this.buildParkSignal(signals, result, currentUser, turnsUsed);
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
      // A park is not an error: core emits route:exchange:suspended once
      // the record is durable, and the agent tier adds no event set of its
      // own. Everything else is a real failure.
      if (!isSuspendSignal(err)) this.emitError(err);
      throw err;
    }
  }

  /**
   * Turn a collected batch of suspend signals into the core signal the
   * hosting step converts into a park.
   *
   * The winner is the FIRST suspended tool call in the model's own
   * emission order (deterministic under parallel execution, unlike
   * completion order); every other suspend signal in the batch is
   * rewritten in the persisted thread to a retryable tool error, so one
   * exchange parks exactly once per sequence number and the resumed model
   * can re-ask the losers.
   *
   * @internal
   */
  private buildParkSignal(
    signals: AgentSuspendSignalRecord[],
    result: LlmResult,
    currentUser: string | ThreadMessage[],
    turnsUsed: number,
  ): SuspendSignal {
    // Signals are only ever recorded through a bridge this session created,
    // and the bridge exists only when the input carries suspension wiring,
    // so this guard is wiring defence rather than a reachable path.
    const suspension = this.input.suspension;
    if (!suspension) {
      throw rcError("AI1006", undefined, {
        message:
          "A tool suspended, but this dispatch carries no suspension wiring. Durable suspension is only available inside an agent dispatch on a route-bound exchange.",
      });
    }
    let messages: readonly ThreadMessage[] = historyMessages(
      this.input.user,
      currentUser,
      result,
    );
    const winner = pickWinningSignal(signals, messages);
    // Prove the answer has somewhere to land BEFORE the record is written:
    // a park whose thread lacks the winning call would hand out a token
    // whose first resume throws AI1007 and burns the single-use claim,
    // stranding the work. Failing here keeps the run re-drivable.
    if (
      !replaceToolResultOutput(messages, winner.toolCallId, {
        type: "json",
        value: null,
      }).found
    ) {
      throw rcError("AI1007", undefined, {
        message: `Tool "${winner.toolName}" suspended, but its call "${winner.toolCallId}" is not in the thread about to be persisted, so no resume could ever deliver the answer. Nothing was parked.`,
      });
    }
    for (const signal of signals) {
      if (signal === winner) continue;
      const swapped = replaceToolResultOutput(messages, signal.toolCallId, {
        type: "error-text",
        value: SIBLING_SUSPENDED_MESSAGE,
      });
      if (!swapped.found) {
        // Leaving the placeholder in place tells the resumed model the
        // sibling ALSO parked, the opposite of the retry hint it needs.
        this.input.exchange.logger.warn(
          { toolCallId: signal.toolCallId, toolName: signal.toolName },
          "A losing suspend signal's tool call is not in the persisted thread; the resumed model will see its suspended placeholder instead of a retryable error.",
        );
      }
      messages = swapped.messages;
    }
    const stepState: AgentStepState = {
      agentId: suspension.agentId,
      messages,
      suspendedToolCallId: winner.toolCallId,
      turnsUsed,
    };
    const { expect, ttl, question, reason } = winner.request;
    return new SuspendSignal({
      expect,
      ...(ttl !== undefined ? { ttl } : {}),
      ...(question !== undefined ? { question } : {}),
      ...(reason !== undefined ? { reason } : {}),
      stepState,
    });
  }

  /**
   * The typed cancellation failure (#552): what the caller sees instead of
   * a partial `AgentResult` that reads like success. The structured cause
   * carries turns completed and token usage so cost accounting and traces
   * stay honest about work the abort discarded.
   *
   * @internal
   */
  private cancelledError(
    cause: unknown,
    turnsUsed: number,
    usage: LlmUsage | undefined,
  ): Error {
    return rcError(
      "AI1005",
      new AgentCancellationCause(cause, turnsUsed, usage),
      {
        message: `Agent run cancelled after ${turnsUsed} turn(s)${
          usage?.totalTokens !== undefined
            ? ` and ${usage.totalTokens} tokens`
            : ""
        }.`,
      },
    );
  }

  /**
   * Emit `route:agent:started` on the context bus at the start of
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
    ctx.emit("route:agent:started", {
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
   * Emit `route:agent:finished` on the context bus once the
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
    const agentName =
      this.input.agentName !== undefined
        ? { agentName: this.input.agentName }
        : {};
    const identity = {
      routeId: id.routeId,
      exchangeId: id.exchangeId,
      correlationId: id.correlationId,
      ...agentName,
      model: this.input.model,
    };
    ctx.emit("route:agent:finished", {
      ...identity,
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
    ctx.emit("route:agent:usage", {
      ...identity,
      ...(result.usage?.inputTokens !== undefined && {
        inputTokens: result.usage.inputTokens,
      }),
      ...(result.usage?.outputTokens !== undefined && {
        outputTokens: result.usage.outputTokens,
      }),
      ...(result.usage?.totalTokens !== undefined && {
        totalTokens: result.usage.totalTokens,
      }),
      ...(result.usage?.cacheReadTokens !== undefined && {
        cacheReadTokens: result.usage.cacheReadTokens,
      }),
      ...(result.usage?.cacheWriteTokens !== undefined && {
        cacheWriteTokens: result.usage.cacheWriteTokens,
      }),
    });
  }

  /**
   * Emit `route:agent:error` on the context bus when the
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
    ctx.emit("route:agent:error", {
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
  private async prepare(
    abortSignal: AbortSignal,
    signals: AgentSuspendSignalRecord[],
  ): Promise<{
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
      suspension,
    } = this.input;
    const bridge: AgentSuspensionBridge | undefined = suspension
      ? {
          wiring: { id: suspension.id, mintToken: suspension.mintToken },
          signals,
        }
      : undefined;
    const vercelTools = await buildVercelTools(
      tools,
      context,
      abortSignal,
      dispatchIdentity,
      exchange.principal,
      bridge,
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
  user: string | ThreadMessage[],
  remainingTurns: number,
  abortSignal: AbortSignal,
  onDelta: AgentDeltaListener | undefined,
  signals: readonly AgentSuspendSignalRecord[],
): Promise<LlmResult> {
  const toolExtras =
    Object.keys(prepared.vercelTools).length > 0
      ? {
          tools: prepared.vercelTools,
          stopWhen: await buildStopWhen(remainingTurns, signals),
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

async function buildStopWhen(
  maxTurns: number,
  signals: readonly AgentSuspendSignalRecord[],
): Promise<unknown> {
  const { stepCountIs } = await import("ai");
  // The second condition is what stops the SDK loop mid-run when a tool
  // suspends: the bridge records the signal and answers the call with a
  // placeholder, and the loop must not spend another model call on a run
  // that is about to park.
  return [stepCountIs(maxTurns), () => signals.length > 0];
}

/**
 * The user-side thread as of the last model call: the running message
 * array when one exists (a validate retry or a resumed dispatch), or the
 * initial prompt promoted to a user message, followed by the SDK's
 * response messages. This is what a park persists.
 *
 * @internal
 */
function historyMessages(
  initialUser: string,
  currentUser: string | ThreadMessage[],
  lastResult: LlmResult,
): ThreadMessage[] {
  const userMsgs: ThreadMessage[] =
    typeof currentUser === "string"
      ? [{ role: "user", content: initialUser }]
      : currentUser;
  // The SDK owns the full ModelMessage shape; ThreadMessage is the
  // structural slice the park persists. One cast, at the SDK boundary.
  return [
    ...userMsgs,
    ...((lastResult.responseMessages ?? []) as ThreadMessage[]),
  ];
}

/**
 * Whether a thrown value reads as an abort, whatever layer wrapped it. The
 * primary cancellation test is the signal itself; this catches an SDK that
 * throws before the signal flag is observable to us.
 *
 * @internal
 */
function isAbortLike(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  );
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
  currentUser: string | ThreadMessage[],
  lastResult: LlmResult,
  validatorMsg: string,
): ThreadMessage[] {
  const userMsgs: ThreadMessage[] =
    typeof currentUser === "string"
      ? [{ role: "user", content: initialUser }]
      : currentUser;
  // Same SDK-boundary cast as historyMessages: ModelMessage narrowed to
  // the structural slice this module threads through.
  const responseMessages = (lastResult.responseMessages ??
    []) as ThreadMessage[];
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
