/**
 * What every ACP connection on one context shares: the agents it serves,
 * the routes their turns run on, the table of prompt requests currently
 * open, and the one bus subscription that feeds their streams.
 *
 * Delivery is per conversation, not per request. `session/update` carries
 * a session id and no prompt id, so the editor attributes whatever streams
 * to whichever `session/prompt` it has open. A message that queues behind
 * a running turn is answered by the boundary turn, which runs on the
 * exchange that parked, so its deltas and tool events arrive under an
 * earlier prompt's correlation id. Routing by that id alone would drop
 * them. Instead every update is routed to the oldest request still open
 * on its conversation, and the request that queued the message is held
 * open until the turn answering it has ended, so the reply streams while
 * it is the one the editor attributes to.
 */

import { randomUUID } from "node:crypto";
import {
  CraftClient,
  HeadersKeys,
  rcError,
  type CraftContext,
  type EventPayload,
  type Exchange,
  type ExchangeHeaders,
  type Principal,
} from "@routecraft/routecraft";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentDelta } from "../agent/events.ts";
import { ADAPTER_AGENT_REGISTRY } from "../agent/store.ts";
import { AgentSessionRuntime, sessionTurnOf } from "../agent/session/index.ts";
import type {
  AgentSessionKey,
  AgentSessionScope,
} from "../agent/session/types.ts";
import type { AgentRegisteredOptions, AgentResult } from "../agent/types.ts";
import {
  AGENT_SURFACE_HEADER,
  registerTurn,
  type AgentSurfaceRef,
} from "../surface/index.ts";
import {
  TurnUpdates,
  type UpdateSink,
  deltaUpdate,
  toolCallUpdate,
  toolFailedUpdate,
  toolResultUpdate,
} from "./updates.ts";
import type { AcpPluginOptions } from "./types.ts";

/**
 * Route id prefix for the one route per agent the plugin builds.
 *
 * Namespaced so it cannot collide with a route somebody wrote, and refused
 * loudly by `registerRoutes` if it somehow does. A prompt is an ordinary
 * send into one of these, which is what keeps every turn an ordinary
 * exchange with telemetry, route events and error handling working exactly
 * as they do everywhere else. No protocol method is overridable by naming
 * a route after it: the mount dispatches by agent name, never by method.
 *
 * @internal
 */
export const ACP_ROUTE_PREFIX = "routecraft.acp.agent.";

/** The body a prompt sends into an agent's route. @internal */
export interface AcpPromptBody {
  readonly session: string;
  readonly message: string;
}

/** One prompt request in flight, keyed by the correlation id the mount minted for it. */
interface LiveTurn {
  readonly updates: TurnUpdates;
  readonly payloads: boolean;
  /** The conversation, which is what an update is routed by. */
  readonly session: string;
  /** Settles once this request's response may go back to the editor. */
  readonly done: Promise<void>;
}

/**
 * The shared half of the mount.
 *
 * One per plugin install. It holds the request table and the bus
 * subscription, because both outlive any single connection: a turn started
 * on one connection can still be draining when that connection drops, and
 * a subscription per turn would churn a listener per prompt.
 */
export class AcpRuntime {
  private readonly turns = new Map<string, LiveTurn>();
  /**
   * The turns whose reply has reached the editor as a message chunk, per
   * conversation. A turn's text is sent once at the end when nothing
   * streamed, and several held requests can end on one turn, so the check
   * is per turn rather than per request. Cleared when a conversation has
   * no request open.
   */
  private readonly spoken = new Map<string, Set<string>>();
  private readonly client: CraftClient;
  private readonly unsubscribes: Array<() => void> = [];

  constructor(
    readonly context: CraftContext,
    private readonly options: AcpPluginOptions,
  ) {
    this.client = new CraftClient(context);
  }

  /** Whether a tool call's arguments and result reach the editor. */
  get toolCallPayloads(): boolean {
    return this.options.toolCallPayloads !== false;
  }

  /** Every agent this context holds, read live so plugin order cannot fix it. */
  agents(): ReadonlyMap<string, AgentRegisteredOptions> {
    return (
      this.context.getStore(ADAPTER_AGENT_REGISTRY) ??
      new Map<string, AgentRegisteredOptions>()
    );
  }

  /** The session runtime, which is where ownership and turns live. */
  sessions(): AgentSessionRuntime {
    return AgentSessionRuntime.for(this.context);
  }

  /**
   * The agent a harness serves when it names none.
   *
   * Three steps, and the third is a refusal rather than a guess: picking
   * one of several agents for somebody would be a decision the app never
   * made.
   *
   * @throws RC5003 when the context holds several agents and none was configured
   */
  defaultAgent(): string {
    const agents = this.agents();
    const configured = this.options.agent;
    if (configured !== undefined) {
      if (!agents.has(configured)) {
        throw rcError("RC5003", undefined, {
          message: `acpPlugin({ agent: "${configured}" }) names an agent this context does not hold. It holds ${describeAgents(agents)}.`,
        });
      }
      return configured;
    }
    if (agents.size === 1) return [...agents.keys()][0]!;
    throw rcError("RC5003", undefined, {
      message: `This instance holds ${agents.size === 0 ? "no agents" : `${agents.size} agents`}, so there is no obvious one to talk to. Set acpPlugin({ agent }) to choose the default${agents.size === 0 ? "" : `, or pick one from the "agent" option: ${describeAgents(agents)}`}.`,
    });
  }

  /**
   * Subscribe the tool-event half of the merge, once for the plugin's life.
   *
   * The events are broadcast synchronously on the context bus, so the
   * handler cannot await: it enqueues, and the request's own pump is what
   * sends. Routing is by the session the event names, falling back to the
   * correlation id the mount put on the exchange; an event from a route
   * that is neither is simply not in the table.
   */
  subscribe(): void {
    const on = <K extends ToolEventName>(
      name: K,
      update: (
        turn: LiveTurn,
        details: EventPayload<K>["details"],
      ) => SessionUpdate,
    ): void => {
      this.unsubscribes.push(
        this.context.on(name, ({ details }) => {
          const turn = this.targetFor(details.correlationId, details.session);
          if (turn !== undefined) this.tell(turn, update(turn, details));
        }),
      );
    };

    on("route:agent:tool:invoked", (turn, details) =>
      toolCallUpdate(
        details.toolCallId,
        details.toolName,
        details._snapshot?.input,
        turn.payloads,
      ),
    );
    on("route:agent:tool:result", (turn, details) =>
      toolResultUpdate(
        details.toolCallId,
        details._snapshot?.output,
        turn.payloads,
      ),
    );
    on("route:agent:tool:error", (_turn, details) =>
      toolFailedUpdate(
        details.toolCallId,
        `${details.toolName} failed: ${details.errorName}`,
      ),
    );
    on("route:agent:tool:refused", (_turn, details) =>
      toolFailedUpdate(
        details.toolCallId,
        `${details.toolName} was refused${details.rc === undefined ? "" : ` (${details.rc})`}`,
      ),
    );
  }

  /**
   * Push one update at the editor, and handle the failure here.
   *
   * Nobody awaits a tool event: the turn belongs to the route, not to the
   * connection. So this is the boundary for a send that fails, and a
   * closed connection is the ordinary way it does, when somebody shuts
   * their editor while a turn is still running. Debug rather than warn for
   * exactly that reason. Left unhandled, the rejection reaches the process
   * and takes down an instance serving everybody else.
   *
   * The branch is defence rather than a fix for an observed failure: the
   * disconnect sequences reachable from a test all settle the turn before
   * an event can land on a dead connection, so `acp-streaming` exercises
   * the sequence without provoking the send failure itself.
   */
  private tell(turn: LiveTurn, update: SessionUpdate): void {
    this.record(turn.session, update);
    turn.updates.push(update).catch((error: unknown) => {
      this.context.logger.debug(
        { err: error, session: turn.session, source: "acp" },
        "Dropped a tool update: the editor is no longer listening",
      );
    });
  }

  /** Drop the bus subscription. Called at teardown. */
  unsubscribe(): void {
    for (const off of this.unsubscribes.splice(0)) off();
  }

  /**
   * The delta sink for an exchange on an agent's route.
   *
   * Resolved per delta rather than once: the exchange a boundary turn runs
   * on is the one that parked, whose own request has long returned, so
   * the target is whichever request is open on the conversation when the
   * delta arrives. A delta with no request open is dropped, as it was when
   * the table was keyed by correlation id alone.
   */
  sinkFor(exchange: Exchange<unknown>): (delta: AgentDelta) => Promise<void> {
    const correlationId = correlationOf(exchange);
    const session = promptBodyOf(exchange).session;
    return (delta) => {
      const turn = this.targetFor(correlationId, session);
      if (turn === undefined) return Promise.resolve();
      const update = deltaUpdate(delta);
      this.record(session, update);
      return turn.updates.push(update);
    };
  }

  /**
   * Run one turn as an ordinary exchange on the agent's own route.
   *
   * The correlation id is minted here and put on the exchange, so the
   * mount holds the turn's identity before a single delta or tool event
   * exists and the merge has nothing to race. The caller's principal rides
   * the same headers, so every hand's `.authorize()` runs per call under
   * the person who typed the prompt; the agent itself carries no
   * authorization and we never claim it does.
   *
   * A message that queues behind a running turn keeps this request open
   * until the turn that consumes it ends (the route's agent step holds),
   * so the reply streams to the editor while this request is the one it
   * attributes updates to. Several requests held on one conversation end
   * on the same turn and carry the same reply.
   */
  async runTurn(
    key: AgentSessionKey,
    agent: string,
    message: string,
    principal: Principal | undefined,
    surface: AgentSurfaceRef,
    sink: UpdateSink,
  ): Promise<AgentResult> {
    const correlationId = randomUUID();
    const updates = new TurnUpdates(sink);
    // Requests answer in the order they were opened: several held on one
    // conversation end on one turn together, and an editor that sent them
    // in order sees them settle in order.
    const ahead = [...this.turns.values()]
      .filter((turn) => turn.session === key)
      .map((turn) => turn.done);
    let finished!: () => void;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    this.turns.set(correlationId, {
      updates,
      payloads: this.toolCallPayloads,
      session: key,
      done,
    });
    // The turn is findable by its correlation id as well as by the header,
    // so a route the agent calls as a hand can reach the person too.
    const forgetTurn = registerTurn(this.context, correlationId, surface);
    const headers: ExchangeHeaders = {
      [HeadersKeys.CORRELATION_ID]: correlationId,
      [AGENT_SURFACE_HEADER]: surface,
      ...(principal !== undefined
        ? { [HeadersKeys.AUTH_PRINCIPAL]: principal }
        : {}),
    };
    try {
      const result = await this.client.sendDirect<AcpPromptBody, AgentResult>(
        `${ACP_ROUTE_PREFIX}${agent}`,
        { session: key, message },
        headers,
      );
      // A provider that does not stream produced no deltas, so the reply
      // is only in the result. Sent once here rather than never, and never
      // twice: a streamed turn has already said it, and the first of
      // several requests held on one turn says it for all of them.
      const turn = sessionTurnOf(result);
      if (
        result.text !== "" &&
        turn !== undefined &&
        !(this.spoken.get(key)?.has(turn) ?? false)
      ) {
        const update: SessionUpdate = {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: result.text },
        };
        this.spokenFor(key).add(turn);
        await updates.push(update);
      }
      return result;
    } finally {
      // Removed before the drain, so a late tool event from a route that
      // outlived the turn finds no queue rather than a closed one.
      this.turns.delete(correlationId);
      if (this.holderFor(key) === undefined) this.spoken.delete(key);
      forgetTurn();
      await updates.close();
      await Promise.allSettled(ahead);
      finished();
    }
  }

  /** The scope a connection's principal reads sessions under. */
  static scopeFor(principal: Principal | undefined): AgentSessionScope {
    return { owner: principal?.subject ?? null };
  }

  /**
   * Where an update produced under a correlation id, for a conversation,
   * goes: the request that minted the id while it is open, else the oldest
   * request open on the conversation.
   */
  private targetFor(
    correlationId: string,
    session: string | undefined,
  ): LiveTurn | undefined {
    return (
      this.turns.get(correlationId) ??
      (session === undefined ? undefined : this.holderFor(session))
    );
  }

  /** The oldest request open on a conversation, or `undefined` when none is. */
  private holderFor(session: string): LiveTurn | undefined {
    for (const turn of this.turns.values()) {
      if (turn.session === session) return turn;
    }
    return undefined;
  }

  /**
   * Note that the turn running on a conversation has spoken, when the
   * update is one of the agent's own words.
   */
  private record(session: string, update: SessionUpdate): void {
    if (update.sessionUpdate !== "agent_message_chunk") return;
    const turn = this.sessions().turnIdOf(session);
    if (turn !== undefined) this.spokenFor(session).add(turn);
  }

  private spokenFor(session: string): Set<string> {
    const existing = this.spoken.get(session);
    if (existing !== undefined) return existing;
    const created = new Set<string>();
    this.spoken.set(session, created);
    return created;
  }
}

/** The body the mount sent, read off an exchange on an agent's route. */
function promptBodyOf(exchange: Exchange<unknown>): AcpPromptBody {
  return exchange.body as AcpPromptBody;
}

/** The correlation id the mount minted for this turn. */
function correlationOf(exchange: Exchange<unknown>): string {
  const correlation = exchange.headers[HeadersKeys.CORRELATION_ID];
  return typeof correlation === "string" ? correlation : exchange.id;
}

type ToolEventName =
  | "route:agent:tool:invoked"
  | "route:agent:tool:result"
  | "route:agent:tool:error"
  | "route:agent:tool:refused";

function describeAgents(
  agents: ReadonlyMap<string, AgentRegisteredOptions>,
): string {
  const names = [...agents.keys()];
  return names.length === 0 ? "none" : names.map((n) => `"${n}"`).join(", ");
}
