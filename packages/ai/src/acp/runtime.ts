/**
 * What every ACP connection on one context shares: the agents it serves,
 * the routes their turns run on, the live turn table the update merge
 * filters against, and the one bus subscription that feeds it.
 */

import { randomUUID } from "node:crypto";
import {
  CraftClient,
  HeadersKeys,
  rcError,
  type CraftContext,
  type EventPayload,
  type ExchangeHeaders,
  type Principal,
} from "@routecraft/routecraft";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentDelta } from "../agent/events.ts";
import { ADAPTER_AGENT_REGISTRY } from "../agent/store.ts";
import { AgentSessionRuntime } from "../agent/session/index.ts";
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

/** One turn in flight, keyed by the correlation id the mount minted for it. */
interface LiveTurn {
  readonly updates: TurnUpdates;
  readonly payloads: boolean;
  /** The conversation, so a dropped update names one in the log. */
  readonly session: string;
}

/**
 * The shared half of the mount.
 *
 * One per plugin install. It holds the turn table and the bus
 * subscription, because both outlive any single connection: a turn started
 * on one connection can still be draining when that connection drops, and
 * a subscription per turn would churn a listener per prompt.
 */
export class AcpRuntime {
  private readonly turns = new Map<string, LiveTurn>();
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
   * The persona a new conversation gets when the client names none.
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
   * handler cannot await: it enqueues, and the turn's own pump is what
   * sends. Filtering is by the correlation id the mount put on the
   * exchange, so an event from any other route on the instance is simply
   * not in the table.
   */
  subscribe(): void {
    const on = <K extends ToolEventName>(
      name: K,
      handle: (turn: LiveTurn, details: EventPayload<K>["details"]) => void,
    ): void => {
      this.unsubscribes.push(
        this.context.on(name, ({ details }) => {
          const turn = this.turns.get(details.correlationId);
          if (turn !== undefined) handle(turn, details);
        }),
      );
    };

    on("route:agent:tool:invoked", (turn, details) => {
      this.tell(
        turn,
        toolCallUpdate(
          details.toolCallId,
          details.toolName,
          details._snapshot?.input,
          turn.payloads,
        ),
      );
    });
    on("route:agent:tool:result", (turn, details) => {
      this.tell(
        turn,
        toolResultUpdate(
          details.toolCallId,
          details._snapshot?.output,
          turn.payloads,
        ),
      );
    });
    on("route:agent:tool:error", (turn, details) => {
      this.tell(
        turn,
        toolFailedUpdate(
          details.toolCallId,
          `${details.toolName} failed: ${details.errorName}`,
        ),
      );
    });
    on("route:agent:tool:refused", (turn, details) => {
      this.tell(
        turn,
        toolFailedUpdate(
          details.toolCallId,
          `${details.toolName} was refused${details.rc === undefined ? "" : ` (${details.rc})`}`,
        ),
      );
    });
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

  /** The delta sink for a turn, or `undefined` for an exchange that is not one. */
  deltaSinkFor(
    correlationId: string,
  ): ((delta: AgentDelta) => Promise<void>) | undefined {
    const turn = this.turns.get(correlationId);
    if (turn === undefined) return undefined;
    return (delta) => turn.updates.push(deltaUpdate(delta));
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
   */
  async runTurn(
    key: AgentSessionKey,
    message: string,
    principal: Principal | undefined,
    surface: AgentSurfaceRef,
    sink: UpdateSink,
  ): Promise<AgentResult> {
    const correlationId = randomUUID();
    const updates = new TurnUpdates(sink);
    this.turns.set(correlationId, {
      updates,
      payloads: this.toolCallPayloads,
      session: key.session,
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
        `${ACP_ROUTE_PREFIX}${key.agent}`,
        { session: key.session, message },
        headers,
      );
      // A provider that does not stream produced no deltas, so the reply
      // is only in the result. Sent once here rather than never, and never
      // twice: a streamed turn has already said it.
      if (!updates.sentAnyMessage && result.text !== "") {
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
      forgetTurn();
      await updates.close();
    }
  }

  /** The scope a connection's principal reads sessions under. */
  static scopeFor(principal: Principal | undefined): AgentSessionScope {
    return { owner: principal?.subject ?? null };
  }
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
