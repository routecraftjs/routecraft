import {
  getExchangeContext,
  getExchangeRoute,
  markSuspendCapable,
  parkAside,
  peekResumeStepState,
  rcError,
  type CraftContext,
  type Enricher,
  type Exchange,
  type Principal,
  type StepSignalContext,
} from "@routecraft/routecraft";
import { BLOCK_RESERVED_PREFIX, resolveBlocks } from "../block/resolve.ts";
import type { BlockBody, Blocks } from "../block/types.ts";
import { resolveModel, resolvePrompt } from "../llm/shared.ts";
import {
  AgentRun,
  buildUserPrompt,
  dispatchIdentityFrom,
  type AgentDispatchIdentity,
  type AgentRunInput,
  type AgentRunResume,
  type AgentRunSuspension,
} from "./run.ts";
import { rehydrateSession } from "./suspension-state.ts";
import {
  ADAPTER_AGENT_DEFAULT_OPTIONS,
  ADAPTER_AGENT_REGISTRY,
  ADAPTER_AGENT_TOOL_POLICIES,
  AGENT_DEFAULT_OPTION_KEYS,
} from "./store.ts";
import { isGovernableToolKind, policiesAdmit } from "./tools/policy.ts";
import type {
  AgentToolDescriptor,
  AgentToolPolicyContext,
  AgentToolSource,
} from "./tools/policy.ts";
import { anySignal } from "@routecraft/routecraft";
import { streamAgentDeltas, type AgentStream } from "./delta-stream.ts";
import type { AgentDeltaListener } from "./events.ts";
import type { ResolvedTool } from "./tools/selection.ts";
import type {
  AgentOptions,
  AgentPrincipalRenderer,
  AgentRegisteredOptions,
  AgentResult,
  AgentInterruptSource,
  AgentSessionSource,
} from "./types.ts";
import {
  AgentSessionRuntime,
  isSessionParkMarker,
  sessionSystemBlock,
  type AgentSessionKey,
  type AgentSessionPark,
  type AgentSessionParkMarker,
  type AgentTurnExecutor,
} from "./session/index.ts";
import type { ThreadMessage } from "./suspension-state.ts";

const AGENT_REGISTRY_STORE_DESCRIPTION =
  ADAPTER_AGENT_REGISTRY.description ?? "routecraft.adapter.agent.registry";

/**
 * Per-call overrides accepted by the by-name `agent("name", { ... })`
 * factory. Constrained to fields that are inherently request-scoped:
 * the SSE / WebSocket / TUI consumer for `onDelta` is not known at
 * registration time, and which conversation a message belongs to
 * (`session`, `interrupt`) is a property of the message, not of the
 * agent. Anything else (model, system, tools, output) stays
 * authoritative on the registered options.
 *
 * @template T - Body type available to the resolver callbacks
 */
export interface AgentByNameOverrides<T = unknown> {
  /**
   * Per-request token-delta listener. Mirrors `AgentOptions.onDelta`
   * but lives at the call site so each dispatch can stream into its
   * own consumer without cross-talk.
   */
  onDelta?: AgentDeltaListener;
  /**
   * The conversation this message belongs to. Same contract as
   * {@link AgentOptions.session}; the per-call value wins over one on the
   * registered options.
   */
  session?: AgentSessionSource<T>;
  /**
   * Cancel the session's running turn before answering this message. Same
   * contract as {@link AgentOptions.interrupt}; the per-call value wins.
   */
  interrupt?: AgentInterruptSource<T>;
}

/**
 * Discriminated state: inline options or a registry name.
 * @internal
 */
export type AgentBinding<T = unknown> =
  | { kind: "inline"; options: AgentOptions<T> }
  | {
      kind: "by-name";
      name: string;
      perCall?: AgentByNameOverrides<T>;
    };

/**
 * Agent enricher adapter. Resolves agent options (inline or
 * registered), merges them with `agentPlugin({ defaultOptions })`,
 * resolves the agent's tool selection against the live context, and
 * dispatches the tool-calling loop via {@link AgentRun}.
 *
 * Fetch-only: an agent run PRODUCES a value, so it fills the `fetch` slot and
 * implements no `send`. The resulting `AgentResult { text, output?,
 * reasoning?, usage? }` becomes the body in `.to()` / bare `.enrich()`, feeds
 * the aggregator in `.enrich(x, agg)`, and is discarded by `.tap()`.
 *
 * Resolution: when constructed inline, uses options directly. When
 * constructed by name, resolves the registered agent from the context
 * store (`ADAPTER_AGENT_REGISTRY`) at dispatch time, throwing a clear
 * error if the name is unknown.
 */
export class AgentEnricherAdapter<T = unknown> implements Enricher<
  T,
  AgentResult | AgentStream
> {
  readonly adapterId = "routecraft.adapter.agent";

  constructor(public readonly binding: AgentBinding<T>) {
    // A tool handler may park the run (ctx.suspend / SuspendError), so the
    // suspend-site walk assigns this adapter's hosting step a re-entrant
    // site at build time. Routes that never suspend pay nothing for it.
    markSuspendCapable(this);
  }

  async fetch(
    exchange: Exchange<T>,
    stepCtx?: StepSignalContext,
  ): Promise<AgentResult | AgentStream> {
    const context = getExchangeContext(exchange);
    const baseOptions = this.resolveOptions(context);
    const merged = mergeWithDefaults(baseOptions, context);

    if (merged.model === undefined) {
      throw rcError("RC5003", undefined, {
        message:
          `Agent: no "model" supplied and no agentPlugin({ defaultOptions: { model } }) is set on this context. ` +
          `Specify "model" on the agent or set a context-level default.`,
      });
    }
    const model = merged.model;

    const { config, modelName } = resolveModel(model, context);
    // Registered agents carry their own id (used to attribute runs in
    // observability, and to name the agent in a tool-policy denial);
    // inline agents are identified by their route, so agentName stays
    // undefined and the consumer falls back to routeId.
    const agentName =
      this.binding.kind === "by-name" ? this.binding.name : undefined;
    // Resolved before tools so a tool-policy denial can be emitted as an
    // exchange-scoped event, not just logged.
    const route = getExchangeRoute(exchange);
    const dispatchIdentity = dispatchIdentityFrom(
      exchange,
      route?.definition.id,
    );

    // Durable suspension is available exactly when the exchange is
    // route-bound: without a dispatch identity there is no site to park
    // against, so no wiring is handed out and ctx.suspend refuses (AI1006).
    const agentIdentity = agentName ?? dispatchIdentity?.routeId;
    // Withheld under `stream: true`. The dispatch returns its iterable the
    // moment the run starts, so this step has already settled by the time a
    // tool could park it: the sentinel would reach the stream's consumer as
    // an ordinary failure and the exchange would never park, stranding a
    // resume token the handler had already sent. Refusing at the handler
    // instead (AI1006, the same refusal an unbound dispatch gets) puts the
    // error where the author can act on it.
    const suspension: AgentRunSuspension | undefined =
      dispatchIdentity && agentIdentity !== undefined && merged.stream !== true
        ? {
            id: exchange.suspension.id,
            // Lazy: minting reads the context's signer and throws RC5052
            // without a suspension runtime; a handler that never builds a
            // resume link should not pay for or fail on it.
            mintToken: (callBinding: string) =>
              exchange.suspension.tokenFor(callBinding),
            agentId: agentIdentity,
          }
        : undefined;

    // A resumed exchange re-enters this step carrying the parked loop
    // state. Read without consuming: the executor clears the slot when
    // this step settles, so a retried attempt (a provider 429 here, or a
    // setup failure below) still resumes instead of silently re-running
    // the whole loop from the original prompt.
    const resumeRaw = peekResumeStepState(exchange);
    // A revived session continuation re-enters here too, carrying only
    // the session's name: the transcript and the inbox are in the session
    // record, and the turn they make is the runtime's to run.
    const revivedPark = isSessionParkMarker(resumeRaw) ? resumeRaw : undefined;
    const resume: AgentRunResume | undefined =
      resumeRaw !== undefined && revivedPark === undefined
        ? rehydrateSession(resumeRaw, agentIdentity, exchange.suspension.result)
        : undefined;

    const userTools = resolveAgentTools(
      merged,
      context,
      agentName,
      dispatchIdentity,
    );
    const user = buildUserPrompt(merged, exchange);
    // System accepts the same string-or-function shape as `llm({ system })`,
    // so resolve it against the exchange here. The session then receives a
    // plain string, matching what the provider layer expects.
    const baseSystem = resolvePrompt(merged.system, exchange);
    // Mirror the construction-time check (validateAgentOptions) so a
    // function-form `system` resolver can't silently drop the prompt at
    // dispatch by returning an empty string.
    if (baseSystem.trim() === "") {
      throw rcError("RC5003", undefined, {
        message:
          `Agent: "system" resolved to an empty string. ` +
          `When "system" is a function, it must return a non-empty string for the incoming exchange.`,
      });
    }
    const { systemAppend, loaderTools } = await resolveBlocks(
      merged.blocks,
      exchange,
      context,
    );
    const tools = mergeUserAndLoaderTools(userTools, loaderTools);
    const withBlocks = `${baseSystem}${systemAppend}`;
    // Caller identity is appended last (after blocks) so the author's own
    // prompt and any block content frame the model first, with the
    // request-scoped "who am I serving" footer closest to the user turn.
    const system = appendPrincipalToSystem(
      withBlocks,
      merged.principal,
      exchange.principal,
      exchange,
    );

    // Thread cancellation through so the agent dispatch (LLM call plus
    // in-flight tool handlers) stops when either owner says so: the
    // route's signal (stop, context shutdown) or the step's signal (a
    // route-scope .timeout() abandoning this run). Falls back to a
    // never-firing signal when the exchange has no route binding (rare;
    // mostly synthetic exchanges in tests).
    //
    // A streaming dispatch adds a third owner, the consumer of the delta
    // stream, so abandoning the stream stops the run (see AgentOptions.stream).
    const consumer = new AbortController();
    const abortSignal = anySignal(
      route?.signal,
      stepCtx?.signal,
      merged.stream === true ? consumer.signal : undefined,
    );

    // Streaming is selected by the presence of `onDelta` on the
    // merged options or as a per-call override at the by-name call
    // site. Per-call wins because it's request-scoped (e.g. a
    // specific SSE channel for THIS dispatch).
    const perCall =
      this.binding.kind === "by-name" ? this.binding.perCall : undefined;
    const onDelta = perCall?.onDelta ?? merged.onDelta;

    const sessionKey =
      revivedPark !== undefined
        ? this.revivedSessionKey(revivedPark, agentIdentity)
        : this.resolveSessionKey(
            perCall?.session ?? merged.session,
            exchange,
            agentIdentity,
            merged.stream === true,
          );
    const backgroundTools = tools.filter((tool) => tool.background === true);
    if (sessionKey === undefined && backgroundTools.length > 0) {
      throw rcError("RC5003", undefined, {
        message:
          `Agent${agentName !== undefined ? ` "${agentName}"` : ""}: ${backgroundTools.map((t) => `"${t.name}"`).join(", ")} ${backgroundTools.length === 1 ? "is" : "are"} declared background: true, which delivers the result to the calling session's inbox, and this dispatch carries no session. ` +
          `Dispatch the agent with agent(name, { session }), or register the tool without the background flag.`,
      });
    }
    // Built once for both paths: a field added here reaches a session turn
    // and a one-shot run alike, where two literals would let one drift.
    const base = {
      options: merged,
      modelConfig: config,
      modelName,
      model,
      ...(agentName !== undefined && { agentName }),
      tools,
      user,
      system,
      context,
      exchange,
      dispatchIdentity,
      ...(suspension !== undefined && { suspension }),
    } satisfies Omit<AgentRunInput<T>, "onStep" | "resume" | "session">;

    if (sessionKey !== undefined) {
      if (!context) {
        throw rcError("RC5003", undefined, {
          message: `Agent: "session" needs a CraftContext to keep the conversation in; this exchange has none.`,
        });
      }
      if (resume !== undefined) {
        throw rcError("RC5003", undefined, {
          message: `Agent: a resumed suspension cannot re-enter an agent dispatched with "session". A session turn is not parkable; drop "session" on this route or park from a sessionless agent.`,
        });
      }
      const interrupt = perCall?.interrupt ?? merged.interrupt;
      // Where this exchange can be parked for a later turn: the re-entrant
      // site the build assigned this step, when it sits on the primary flow.
      const site = route?.definition.reentrantSuspendSteps?.find(
        (host) => host.adapter === this,
      )?.suspendSite;
      const routeId = route?.definition.id;
      const park =
        site !== undefined && routeId !== undefined
          ? async (): Promise<AgentSessionPark> => {
              const { suspensionId } = await parkAside(
                context,
                exchange,
                site,
                routeId,
                (id): AgentSessionParkMarker => ({
                  kind: "agent-session-park",
                  agent: sessionKey.agent,
                  session: sessionKey.session,
                  suspensionId: id,
                }),
              );
              return { suspensionId, routeId };
            }
          : undefined;
      return await AgentSessionRuntime.for(context).turn({
        key: sessionKey,
        exchange,
        ...(revivedPark === undefined ? { message: user } : {}),
        ...(park !== undefined ? { park } : {}),
        ...(revivedPark !== undefined
          ? { revived: revivedPark.suspensionId }
          : {}),
        interrupt:
          revivedPark === undefined &&
          (typeof interrupt === "function"
            ? interrupt(exchange) === true
            : interrupt === true),
        executor: this.sessionExecutor(
          {
            ...base,
            system: `${system}\n\n${sessionSystemBlock(sessionKey)}`,
            session: { agent: sessionKey.agent, id: sessionKey.session },
          },
          abortSignal,
          onDelta,
        ),
      });
    }

    const run = new AgentRun<T>({
      ...base,
      ...(resume !== undefined && { resume }),
    });

    // `stream: true` is the pull form of `onDelta` (see AgentOptions.stream).
    if (merged.stream === true) {
      return streamAgentDeltas(
        (emit) => run.runStream(abortSignal, emit),
        (reason) => consumer.abort(reason),
      );
    }
    // The consolidated AgentResult is returned in both remaining paths, so
    // downstream pipeline ops are unaffected by the choice.
    if (onDelta !== undefined) {
      return await run.runStream(abortSignal, onDelta);
    }
    return await run.runUntilDone(abortSignal);
  }

  /**
   * Resolve the session this dispatch belongs to, or `undefined` for the
   * sessionless path every agent took before sessions existed.
   *
   * `stream: true` and `session` do not compose: the stream is handed over
   * before the run ends, so there is no turn boundary at which to store
   * the transcript or drain the inbox. Refused here rather than silently
   * running the turn without the session it was asked for.
   */
  private resolveSessionKey(
    source: AgentSessionSource<T> | undefined,
    exchange: Exchange<T>,
    agentIdentity: string | undefined,
    streaming: boolean,
  ): AgentSessionKey | undefined {
    if (source === undefined) return undefined;
    const resolved = typeof source === "function" ? source(exchange) : source;
    if (typeof resolved !== "string" || resolved.trim() === "") {
      throw rcError("RC5003", undefined, {
        message: `Agent: "session" must resolve to a non-empty string naming the conversation; got ${JSON.stringify(resolved)}.`,
      });
    }
    if (streaming) {
      throw rcError("RC5003", undefined, {
        message: `Agent: "session" and "stream: true" cannot be combined. A session turn stores its transcript when it ends, and a stream is handed over before that. Use "onDelta" for token deltas on a session, or drop "session" to stream.`,
      });
    }
    if (agentIdentity === undefined) {
      throw rcError("RC5003", undefined, {
        message: `Agent: "session" needs an agent identity to key the conversation by, and this dispatch has none: it is neither a registered agent nor on a route. Dispatch through a route, or register the agent by name.`,
      });
    }
    return { agent: agentIdentity, session: resolved };
  }

  /**
   * The session a revived continuation belongs to, from the marker it
   * stored. The agent it names must be the one this step dispatches: the
   * marker is read off the store, and a route rebound under a park would
   * otherwise run another agent's conversation.
   */
  private revivedSessionKey(
    marker: AgentSessionParkMarker,
    agentIdentity: string | undefined,
  ): AgentSessionKey {
    if (agentIdentity !== marker.agent) {
      throw rcError("AI1007", undefined, {
        message: `This continuation was stored by agent "${marker.agent}", but the revived route now dispatches ${agentIdentity === undefined ? "an agent with no identity" : `"${agentIdentity}"`}. Restore the original agent binding.`,
      });
    }
    return { agent: marker.agent, session: marker.session };
  }

  /**
   * What the session runtime calls to run one turn. A fresh run per call,
   * because the boundary turn that consumes an inbox reuses this executor
   * after the first run has finished, and a run is one turn's state.
   */
  private sessionExecutor(
    input: Omit<AgentRunInput<T>, "onStep" | "resume">,
    abortSignal: AbortSignal,
    onDelta: AgentDeltaListener | undefined,
  ): AgentTurnExecutor {
    let last: AgentRun<T> | undefined;
    return {
      run: async (messages, interrupt, onStep) => {
        // Each turn's budget is its own: `maxTurns` bounds one turn, not
        // the conversation, so the run starts from the stored thread with
        // no turns spent. `usage` is per turn for the same reason.
        const run = new AgentRun<T>({
          ...input,
          resume: { messages: [...messages], turnsUsed: 0 },
          onStep,
        });
        last = run;
        const signal = anySignal(abortSignal, interrupt);
        return onDelta !== undefined
          ? run.runStream(signal, onDelta)
          : run.runUntilDone(signal);
      },
      thread: (): readonly ThreadMessage[] | undefined => last?.thread,
    };
  }

  /** Pull the agent options for this dispatch, either inline or from the registry. */
  private resolveOptions(
    context: CraftContext | undefined,
  ): AgentOptions<T> | AgentRegisteredOptions<T> {
    if (this.binding.kind === "inline") return this.binding.options;

    if (!context) {
      throw rcError("RC5004", undefined, {
        message:
          `Agent "${this.binding.name}" requires a context to resolve. ` +
          `Ensure the exchange has context (e.g. from a route) so the ` +
          `"${AGENT_REGISTRY_STORE_DESCRIPTION}" store can be read.`,
      });
    }
    const registry = context.getStore(ADAPTER_AGENT_REGISTRY);
    if (!registry) {
      throw rcError("RC5004", undefined, {
        message:
          `Agent "${this.binding.name}" not found: no agents registered. ` +
          `Add agentPlugin({ agents: { "${this.binding.name}": {...} } }) to your config.`,
      });
    }
    const found = registry.get(this.binding.name);
    if (!found) {
      const known = Array.from(registry.keys()).join(", ") || "<none>";
      throw rcError("RC5004", undefined, {
        message: `Agent "${this.binding.name}" not found in registry. Known agents: ${known}.`,
      });
    }
    return found as AgentRegisteredOptions<T>;
  }

  /**
   * Extract metadata from the agent result for observability. Includes the
   * resolved model (as string) and token usage when reported.
   */
  getMetadata(result: unknown): Record<string, unknown> {
    const r = result as AgentResult;
    const metadata: Record<string, unknown> = {};
    if (this.binding.kind === "by-name") metadata["agent"] = this.binding.name;
    if (this.binding.kind === "inline") {
      const model = this.binding.options.model;
      if (typeof model === "string") metadata["model"] = model;
    }
    if (r.usage?.inputTokens !== undefined) {
      metadata["inputTokens"] = r.usage.inputTokens;
    }
    if (r.usage?.outputTokens !== undefined) {
      metadata["outputTokens"] = r.usage.outputTokens;
    }
    return metadata;
  }
}

/**
 * Merge per-agent options with the context-level defaults registered
 * via `agentPlugin({ defaultOptions: {...} })`. Per-agent values win
 * per key; missing fields fall back to defaults (mirrors the LLM
 * destination's `mergedOptions` pattern).
 *
 * @internal
 */
function mergeWithDefaults<T>(
  base: AgentOptions<T> | AgentRegisteredOptions<T>,
  context: CraftContext | undefined,
): AgentOptions<T> | AgentRegisteredOptions<T> {
  const defaults = context?.getStore(ADAPTER_AGENT_DEFAULT_OPTIONS);
  if (!defaults) return base;
  const out = { ...base };
  for (const key of AGENT_DEFAULT_OPTION_KEYS) {
    if (out[key] !== undefined) continue;
    const value = defaults[key];
    if (value !== undefined) Object.assign(out, { [key]: value });
  }
  if (defaults.blocks !== undefined) {
    out.blocks = mergeBlocks(defaults.blocks, base.blocks);
  }
  return out;
}

/**
 * Merge default blocks with the agent's own. The per-agent record is
 * applied on top of the defaults by name: a key in both records picks
 * the per-agent body (overrides only that entry); non-colliding
 * defaults still apply; per-agent keys with new names extend the
 * record. A per-agent value of `false` removes the matching default;
 * a `false` for a name absent from defaults is a no-op so adding or
 * removing defaults later cannot break the agent definition.
 *
 * Insertion order is preserved by walking defaults first, then any
 * per-agent keys that didn't override a default. Inject blocks appear
 * in the system prompt in this order, which matters because the model
 * is sensitive to earlier system-prompt content.
 *
 * Merge is by top-level name only. When a name's value is a nested
 * group, a per-agent entry replaces the whole group (not a per-member
 * merge), and `false` removes the whole group. Per-member merge inside
 * a group is intentionally unsupported; see the agentPlugin reference.
 *
 * @internal
 */
function mergeBlocks(
  defaults: { [name: string]: BlockBody | Blocks },
  agent: Blocks | undefined,
): Blocks {
  // Null-prototype accumulator so a block name like `__proto__` cannot
  // mutate Object.prototype via `out[name] = body`. Block-name validation
  // (validateBlocks / validatePluginDefaults) already rejects the
  // reserved `_block_` prefix and empty strings, but `__proto__` is
  // outside both rules, so this is defence-in-depth.
  const out = Object.create(null) as Blocks;
  if (!agent) {
    for (const [name, body] of Object.entries(defaults)) out[name] = body;
    return out;
  }
  for (const [name, body] of Object.entries(defaults)) {
    if (Object.prototype.hasOwnProperty.call(agent, name)) {
      const override = agent[name];
      // `false` removes the default for this agent; an undefined value
      // shouldn't reach here under the Blocks type, but guard anyway.
      if (override === false || override === undefined) continue;
      out[name] = override;
    } else {
      out[name] = body;
    }
  }
  for (const [name, body] of Object.entries(agent)) {
    if (Object.prototype.hasOwnProperty.call(out, name)) continue;
    if (body === false) continue;
    out[name] = body;
  }
  return out;
}

/**
 * Merge user tools (from `tools([...])`) with synthetic block-loader
 * tools produced by {@link resolveBlocks}. Rejects (AI1002) any user
 * tool whose resolved name starts with the reserved `_block_` prefix,
 * so a misconfigured registry cannot shadow the framework's surface.
 *
 * @internal
 */
function mergeUserAndLoaderTools(
  userTools: ResolvedTool[],
  loaderTools: ResolvedTool[],
): ResolvedTool[] {
  for (const tool of userTools) {
    if (tool.name.startsWith(BLOCK_RESERVED_PREFIX)) {
      throw rcError("AI1002", undefined, {
        message: `Agent tool "${tool.name}": names starting with "${BLOCK_RESERVED_PREFIX}" are reserved for synthetic block tools. Rename the fn or route.`,
      });
    }
  }
  return [...userTools, ...loaderTools];
}

/**
 * Resolve the agent's `tools` selection against the live context. The
 * selection is the `ToolSelection` object built via `tools([...])`;
 * resolution walks the fn registry and direct registry to produce the
 * final `ResolvedTool[]` the runtime hands to the LLM.
 *
 * Returns an empty array when the agent has no tools field set
 * (and no context-default tools were inherited).
 *
 * @internal
 */
function resolveAgentTools<T>(
  options: AgentOptions<T> | AgentRegisteredOptions<T>,
  context: CraftContext | undefined,
  agentId: string | undefined,
  dispatchIdentity: AgentDispatchIdentity | undefined,
): ResolvedTool[] {
  if (options.tools === undefined) return [];
  if (!context) {
    throw rcError("RC5003", undefined, {
      message: `Agent: cannot resolve tools without a CraftContext.`,
    });
  }
  return applyToolPolicy(
    options.tools.resolve(context),
    context,
    agentId,
    dispatchIdentity,
  );
}

/**
 * Filter a resolved tool list through every `agentPlugin({ toolPolicy })`
 * installed on the context.
 *
 * This runs at the single point both agent forms converge on. Inline
 * options and by-name registry lookups (which is what a markdown agent
 * becomes) both arrive here through `resolveOptions`, and a nested
 * agent dispatched from inside a route re-enters the same
 * `AgentDestinationAdapter.send`. Enforcement is therefore total by
 * construction rather than by discipline, and stays that way for any
 * future agent form routed through this destination.
 *
 * A denied tool is dropped and logged at warn, not thrown. A silent
 * drop would be undiagnosable when a model starts claiming it cannot do
 * something; a throw would turn tightening a policy into an outage for
 * every agent that happened to list the tool.
 *
 * @internal
 */
function applyToolPolicy(
  resolved: ResolvedTool[],
  context: CraftContext,
  agentId: string | undefined,
  dispatchIdentity: AgentDispatchIdentity | undefined,
): ResolvedTool[] {
  const policies = context.getStore(ADAPTER_AGENT_TOOL_POLICIES);
  if (!policies || policies.length === 0) return resolved;
  const policyContext: AgentToolPolicyContext = { agentId };
  const admitted: ResolvedTool[] = [];
  // A denial is a decision, so it goes on the bus as well as into the
  // log. Alerting on "a tool was silently dropped from an agent" needs
  // something queryable; a log line is not that.
  //
  // `toolKind` is passed in rather than read off the tool, so it is
  // always a kind the policy surface defines. An unclassifiable tool
  // reports `"unknown"`: its raw `source.kind` is whatever a caller
  // outside the type contract put there, so echoing it would hand an
  // audit consumer an unbounded set of kind values that look
  // authoritative while carrying nothing the `reason` does not already
  // say. It also keeps this off the raw `source`, which the
  // unknown-provenance path has deliberately not dereferenced.
  const emitDenied = (
    tool: ResolvedTool,
    reason: "rule" | "rule-error" | "unknown-provenance",
    toolKind: string,
  ): void => {
    if (!dispatchIdentity) return;
    context.emit("route:agent:tool:denied", {
      routeId: dispatchIdentity.routeId,
      exchangeId: dispatchIdentity.exchangeId,
      correlationId: dispatchIdentity.correlationId,
      ...(agentId !== undefined && { agentName: agentId }),
      toolName: tool.name,
      toolKind,
      reason,
    });
  };
  // A predicate that throws is a bug in the policy, not a verdict, so
  // it is reported at error level. The tool is still denied rather than
  // letting the throw abort the dispatch; see `ruleAdmits`.
  const onRuleError = (tool: AgentToolDescriptor, cause: unknown): void => {
    context.logger.error(
      {
        agent: agentId ?? "<inline>",
        tool: tool.name,
        kind: tool.source.kind,
        err: cause,
      },
      // Boundary convention: the thrown message is the log message, with
      // a boundary-specific fallback when the predicate threw something
      // that carries none (it may throw any value at all).
      messageOf(cause) ??
        "Agent tool policy predicate threw; denying the tool. Fix the predicate in agentPlugin({ toolPolicy })",
    );
  };
  for (const tool of resolved) {
    // Classified before the descriptor is built, because building one
    // reads `tool.source` and a malformed tool would throw there,
    // aborting the dispatch. That is the opposite of failing closed,
    // and it would make the `unknown-provenance` arm inside
    // `policiesAdmit` unreachable for the case it exists to handle.
    const descriptor = toDescriptor(tool);
    if (descriptor === undefined) {
      emitDenied(tool, "unknown-provenance", "unknown");
      context.logger.warn(
        { agent: agentId ?? "<inline>", tool: tool.name, kind: "unknown" },
        "Agent tool carries no recognisable resolver-set provenance, so no policy can classify it; dropping it from the agent's tool list",
      );
      continue;
    }
    const verdict = policiesAdmit(
      policies,
      descriptor,
      policyContext,
      onRuleError,
    );
    if (verdict.admitted) {
      admitted.push(tool);
      continue;
    }
    emitDenied(
      tool,
      verdict.reported ? "rule-error" : "rule",
      descriptor.source.kind,
    );
    // A denial already reported through `onRuleError` has been logged at
    // error level with its cause. Repeating it at warn would say less
    // about the same tool and the same outcome, and would bury the line
    // that actually explains what went wrong.
    if (verdict.reported) continue;
    context.logger.warn(
      {
        agent: agentId ?? "<inline>",
        tool: tool.name,
        kind: descriptor.source.kind,
      },
      "Agent tool denied by agentPlugin({ toolPolicy }) and dropped from the agent's tool list",
    );
  }
  return admitted;
}

/**
 * Pull a log message out of a thrown value, preferring a
 * `RoutecraftError`'s `meta.message` over the plain `message`, per the
 * boundary convention in `.standards/error-and-logging-policy.md`.
 * Returns undefined when the value carries no usable message, since a
 * predicate may throw anything.
 *
 * @internal
 */
function messageOf(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  // A predicate may throw anything, including an object whose `meta` or
  // `message` is a getter that itself throws. Reading it must not be
  // able to abort the dispatch the surrounding catch exists to protect.
  try {
    const meta = (cause as { meta?: { message?: unknown } }).meta;
    if (typeof meta?.message === "string" && meta.message !== "") {
      return meta.message;
    }
    const message = (cause as { message?: unknown }).message;
    return typeof message === "string" && message !== "" ? message : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Narrow a `ResolvedTool` to the read-only view policy rules receive.
 * Drops `handler` so a rule cannot wrap or invoke the tool it is
 * deciding about, and normalises absent tags to an empty array so
 * predicates can call `.includes` without a guard.
 *
 * Copied and frozen, following the same convention `buildCatalog` uses
 * for the `tools((catalog) => ...)` builder and `snapshotCapability`
 * uses for the capability registry. Without it, `tags` for a fn tool is
 * the array held in the fn registry and `source.annotations` is the
 * object the MCP client refresh wrote, so a predicate assigning a
 * default (`annotations.destructiveHint ??= true` is the plausible
 * accident) would rewrite shared registry state seen by every later
 * policy, every later dispatch, and the MCP server's own `tools/list`.
 * The `readonly` modifiers are compile-time only and do not stop it.
 *
 * @internal
 */
function toDescriptor(tool: ResolvedTool): AgentToolDescriptor | undefined {
  // `source` is resolver-set, so a tool without a recognisable one came
  // from outside the type contract (a hand-built `ResolvedTool`, or one
  // written against 0.5 typings). Report that as unclassifiable rather
  // than dereferencing into a TypeError: an allowlist cannot admit what
  // it cannot classify, and crashing here would take down the dispatch
  // the policy is supposed to be quietly narrowing.
  //
  // An absent `kind` and an unrecognised one are the same defect and
  // get the same answer. Accepting `{ kind: "bogus" }` here would still
  // deny the tool, one layer down in `policiesAdmit`, but as an
  // ordinary rule denial: the caller would then report reason `rule`
  // and log that a policy decided against a tool no policy ever saw.
  //
  // `block` is not governable but IS resolver-set, so it is classified
  // rather than rejected; `policiesAdmit` exempts it.
  const kind = (tool.source as AgentToolSource | undefined)?.kind;
  if (kind !== "block" && !isGovernableToolKind(kind)) return undefined;
  // The annotations copy is frozen too, not just `source`. One
  // descriptor is built per tool and handed to every composed policy in
  // turn, so a mutable nested object would let the first predicate
  // change what the second one sees, making an AND composition depend
  // on the order its policies happen to be installed in.
  const source =
    tool.source.kind === "mcp" && tool.source.annotations
      ? {
          ...tool.source,
          annotations: Object.freeze({ ...tool.source.annotations }),
        }
      : { ...tool.source };
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    tags: Object.freeze(tool.tags ? [...tool.tags] : []),
    source: Object.freeze(source),
  }) as AgentToolDescriptor;
}

/**
 * Append a `## Caller` section describing the request's principal. Opt-in:
 * returns the base prompt unchanged when `principal` is omitted or `false`,
 * so existing agents are unaffected. When `principal` is a function it
 * renders the section itself (an empty return appends nothing); otherwise
 * the built-in {@link formatCallerSection} block is used.
 *
 * The section is informational context for the model (who triggered the
 * request), never an authorization gate; `.authorize()` and guards remain
 * the only enforcement points.
 *
 * @internal
 */
function appendPrincipalToSystem<T>(
  baseSystem: string,
  principalOption: boolean | AgentPrincipalRenderer<T> | undefined,
  principal: Principal | undefined,
  exchange: Exchange<T>,
): string {
  if (principalOption === undefined || principalOption === false) {
    return baseSystem;
  }
  const section =
    typeof principalOption === "function"
      ? principalOption(principal, exchange)
      : formatCallerSection(principal);
  if (section.trim() === "") return baseSystem;
  return `${baseSystem}\n\n${section}`;
}

/**
 * Render the built-in `## Caller` block from a principal. Surfaces only
 * the loggable identity fields (`name`, `email`, `subject`) and `roles`
 * (see `.standards/security.md` § 3); scopes, `claims`, `userinfoClaims`,
 * and the bearer token are never included. Absent fields are omitted
 * rather than printed as `undefined`. When no principal is present the
 * block states the request is unauthenticated so the model does not
 * invent an identity.
 *
 * @internal
 */
function formatCallerSection(principal: Principal | undefined): string {
  if (!principal) {
    return (
      "## Caller\n\n" +
      "The current request is not authenticated. No verified user identity " +
      "is available. Do not assume, infer, or invent the caller's name, " +
      "email, or permissions."
    );
  }
  const lines: string[] = [];
  if (principal.name) lines.push(`- Name: ${oneLine(principal.name)}`);
  if (principal.email) lines.push(`- Email: ${oneLine(principal.email)}`);
  lines.push(`- Subject: ${oneLine(principal.subject)}`);
  const roles = principal.roles
    ?.map((r) => oneLine(r))
    .filter((r) => r.length > 0);
  if (roles && roles.length > 0) {
    lines.push(`- Roles: ${roles.join(", ")}`);
  }
  return `## Caller\n\nThe current request is authenticated.\n${lines.join("\n")}`;
}

/**
 * Collapse newlines (and surrounding whitespace) in an interpolated
 * identity field. Principal strings like `name` / `email` are
 * integrity-verified (they reached us unmodified from the IdP) but may be
 * subject-controlled at self-service IdPs; collapsing newlines pins a
 * value to its `- Label:` line so it cannot break out of the list item or
 * forge a `##` heading in the trusted system channel.
 *
 * @internal
 */
function oneLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, " ").trim();
}
