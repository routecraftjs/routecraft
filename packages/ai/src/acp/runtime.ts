/**
 * What every ACP connection on one context shares: the agents it serves,
 * the routes their turns run on, the table of prompt requests currently
 * open, and the one bus subscription that feeds their streams.
 *
 * Delivery is per conversation, not per request. `session/update` carries
 * a session id and no prompt id, so the editor attributes whatever streams
 * to whichever `session/prompt` it has open. A message that queues behind
 * a running turn is answered by the boundary turn, which runs on the
 * exchange that deferred, so its deltas and tool events arrive under an
 * earlier prompt's correlation id. Routing by that id alone would drop
 * them. Instead every update is routed to the requests open on its
 * conversation, one per connection, and the request that queued the
 * message is held open until the turn answering it has ended, so the
 * reply streams while it is the one the editor attributes to.
 */

import { randomUUID } from "node:crypto";
import {
  CraftClient,
  HeadersKeys,
  rcCodeOf,
  rcError,
  type CraftContext,
  type EventPayload,
  type Exchange,
  type ExchangeHeaders,
  type Principal,
} from "@routecraft/routecraft";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentDelta } from "../agent/events.ts";
import { correlationOf } from "../agent/run.ts";
import { ADAPTER_AGENT_REGISTRY } from "../agent/store.ts";
import { AgentSessionRuntime } from "../agent/session/index.ts";
import type {
  AgentSessionKey,
  AgentSessionScope,
} from "../agent/session/types.ts";
import type { AgentRegisteredOptions, AgentResult } from "../agent/types.ts";
import {
  AGENT_SURFACE_HEADER,
  AGENT_SURFACES,
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

/**
 * The body the mount sent, read off an exchange on an agent's route.
 *
 * Read rather than validated: the route is `internal`, so the mount is the
 * only thing that can reach it, and a schema here would describe a
 * boundary that does not exist.
 *
 * @internal
 */
export function promptBodyOf(exchange: Exchange<unknown>): AcpPromptBody {
  return exchange.body as AcpPromptBody;
}

/** One prompt request in flight, keyed by the correlation id the mount minted for it. */
interface LiveTurn {
  readonly updates: TurnUpdates;
  readonly payloads: boolean;
  /** The conversation, which is what an update is routed by. */
  readonly session: string;
  /** The connection the request came in on, so one editor is told once. */
  readonly connection: string;
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
   * Which connections have seen a turn's reply as a message chunk, per
   * conversation and turn. A turn's text is sent once at the end when
   * nothing streamed, and several held requests can end on one turn, so
   * the check is per turn and connection rather than per request. Cleared
   * when a conversation has no request open.
   */
  private readonly spoken = new Map<string, Map<string, Set<string>>>();
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
          for (const turn of this.targetsFor(
            details.correlationId,
            details.session,
          )) {
            this.tell(turn, update(turn, details));
          }
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
    on("route:agent:tool:error", (turn, details) =>
      toolFailedUpdate(
        details.toolCallId,
        failureReason(
          details.toolName,
          details.errorName,
          details._snapshot?.error,
          turn.payloads,
        ),
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
   * on is the one that deferred, whose own request has long returned, so
   * the targets are whichever requests are open on the conversation when
   * the delta arrives. A delta with no request open is dropped, as it was
   * when the table was keyed by correlation id alone.
   */
  sinkFor(exchange: Exchange<unknown>): (delta: AgentDelta) => Promise<void> {
    const correlationId = correlationOf(exchange);
    const session = promptBodyOf(exchange).session;
    return async (delta) => {
      const update = deltaUpdate(delta);
      const turn = this.sessions().turnIdOf(session);
      // Settled, not all: one editor gone must not stop the delta reaching
      // another, and its failure is the same closed connection `tell`
      // reports at debug.
      const sent = await Promise.allSettled(
        this.targetsFor(correlationId, session).map((target) => {
          if (update.sessionUpdate === "agent_message_chunk") {
            this.spokenTo(session, turn, target.connection);
          }
          return target.updates.push(update);
        }),
      );
      for (const outcome of sent) {
        if (outcome.status === "rejected") {
          this.context.logger.debug(
            { err: outcome.reason, session, source: "acp" },
            "Dropped a delta: the editor is no longer listening",
          );
        }
      }
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
    // in order sees them settle in order. The newest open request on this
    // editor is enough to wait on, since it waited on the ones before it;
    // another editor's requests are not waited on, so a peer that stopped
    // reading cannot hold up this one's answers.
    let ahead: Promise<void> | undefined;
    for (const turn of this.turns.values()) {
      if (turn.session === key && turn.connection === surface.connection) {
        ahead = turn.done;
      }
    }
    let finished!: () => void;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    this.turns.set(correlationId, {
      updates,
      payloads: this.toolCallPayloads,
      session: key,
      connection: surface.connection,
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
      // A turn that ran with a delta listener has already said its reply
      // (the run hands the listener the whole text). One that ran on
      // another route's continuation, with no listener, has said nothing,
      // so its text is sent here: once per connection, whichever of the
      // requests held on this turn ends first.
      // Out of the table before the write: the next turn may already be
      // running, and its first words must not queue behind this reply on
      // a request that is about to return.
      this.turns.delete(correlationId);
      const turn = result.session?.turn;
      if (
        result.text !== "" &&
        turn !== undefined &&
        this.spokenTo(key, turn, surface.connection)
      ) {
        await updates.push({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: result.text },
        });
      }
      return result;
    } finally {
      // Removed before the drain, so a late tool event from a route that
      // outlived the turn finds no queue rather than a closed one.
      this.turns.delete(correlationId);
      if (this.targetsFor("", key).length === 0) this.spoken.delete(key);
      forgetTurn();
      try {
        await updates.close();
        await ahead;
      } finally {
        finished();
      }
    }
  }

  /** The scope a connection's principal reads sessions under. */
  static scopeFor(principal: Principal | undefined): AgentSessionScope {
    return { owner: principal?.subject ?? null };
  }

  /**
   * Where an update produced under a correlation id, for a conversation,
   * goes: the request that minted the id while it is open, else the
   * oldest request open on the conversation on each connection holding
   * one. One editor is told once however many requests it holds; two
   * editors on one conversation are both told.
   */
  private targetsFor(
    correlationId: string,
    session: string | undefined,
  ): LiveTurn[] {
    const own = this.turns.get(correlationId);
    if (own !== undefined && isSurfaceLive(this.context, own.connection)) {
      return [own];
    }
    if (session === undefined) return [];
    const perConnection = new Map<string, LiveTurn>();
    for (const turn of this.turns.values()) {
      if (
        turn.session === session &&
        !perConnection.has(turn.connection) &&
        // A request whose editor has gone stays in the table until its
        // turn ends; the reply goes to the editor that is still there.
        isSurfaceLive(this.context, turn.connection)
      ) {
        perConnection.set(turn.connection, turn);
      }
    }
    return [...perConnection.values()];
  }

  /**
   * Record that a connection has seen a turn's reply, and say whether it
   * had not before. `turn` is `undefined` for a delta arriving outside
   * any turn this runtime knows, which is recorded against nothing.
   */
  private spokenTo(
    session: string,
    turn: string | undefined,
    connection: string,
  ): boolean {
    if (turn === undefined) return true;
    let turns = this.spoken.get(session);
    if (turns === undefined) {
      turns = new Map();
      this.spoken.set(session, turns);
    }
    let connections = turns.get(turn);
    if (connections === undefined) {
      connections = new Set();
      turns.set(turn, connections);
    }
    if (connections.has(connection)) return false;
    connections.add(connection);
    return true;
  }
}

/** Whether the connection is still registered as a surface, which it is until it closes. */
function isSurfaceLive(context: CraftContext, connection: string): boolean {
  return context.getStore(AGENT_SURFACES)?.has(connection) === true;
}

/**
 * What a person reads when a hand fails.
 *
 * The message is under the same policy as the arguments and the result. A
 * handler's error routinely echoes the input it rejected, so an instance
 * that withholds payloads is told the error's class and code, which are
 * static text, and one that shows them is told the message, with the cause
 * beneath it when there is one, because the reason a route failed is
 * usually one level down from the error it threw.
 */
function failureReason(
  toolName: string,
  errorName: string,
  error: unknown,
  payloads: boolean,
): string {
  const rc = rcCodeOf(error);
  const code = rc === undefined ? "" : ` (${rc})`;
  const floor = `${toolName} failed: ${errorName}${code}`;
  if (!payloads) return floor;
  const message = messageOf(error);
  if (message === "") return floor;
  const cause = error instanceof Error ? messageOf(error.cause) : "";
  const detail =
    cause === "" || message.includes(cause) ? message : `${message}: ${cause}`;
  return `${toolName} failed${code}: ${detail}`;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
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
