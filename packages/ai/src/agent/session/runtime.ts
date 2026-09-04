import { randomUUID } from "node:crypto";
import {
  SUSPENSION_RUNTIME,
  decodeCursor,
  getExchangeRoute,
  rcError,
  takePage,
  type CraftContext,
  type CursorScope,
  type EventDetailsMap,
  type Exchange,
  type OpsPage,
} from "@routecraft/routecraft";
import type { LlmPromptPart } from "../../llm/types.ts";
import { dispatchIdentityFrom } from "../run.ts";
import { ADAPTER_AGENT_SESSIONS } from "../store.ts";
import type { ThreadMessage } from "../suspension-state.ts";
import type { AgentResult } from "../types.ts";
import { closeUnansweredToolCalls, renderUserMessage } from "./render.ts";
import { AgentSessionStore } from "./store.ts";
import type {
  AgentBackgroundCall,
  AgentInboxMessage,
  AgentSessionKey,
  AgentSessionRecord,
  AgentSessionSummary,
} from "./types.ts";

/**
 * What the runtime needs from the agent step to run one turn. Built by the
 * enricher, which owns the model, the tools and the exchange; the runtime
 * owns when a turn runs and what thread it starts from.
 *
 * @internal
 */
export interface AgentTurnExecutor {
  /**
   * Run one turn from `messages` (the transcript with the new user message
   * already appended). `interrupt` fires when a later message asks for
   * this turn to stop; `onStep` is called after every finished step with
   * the thread so far, and the runtime persists from it.
   */
  run(
    messages: readonly ThreadMessage[],
    interrupt: AbortSignal,
    onStep: (messages: readonly ThreadMessage[]) => Promise<void>,
  ): Promise<AgentResult>;
  /** The thread the last `run` reached, complete or partial. */
  thread(): readonly ThreadMessage[] | undefined;
}

/** One dispatch that carries a session. @internal */
export interface AgentTurnRequest<T = unknown> {
  readonly key: AgentSessionKey;
  readonly exchange: Exchange<T>;
  readonly message: string | LlmPromptPart[];
  readonly interrupt: boolean;
  readonly executor: AgentTurnExecutor;
}

/** What the management API asks of the session listing. @internal */
export interface AgentSessionListQuery {
  /** Only this agent's sessions. */
  readonly agent?: string;
  /** Page size; the mount's default and bound apply. */
  readonly limit?: number;
  /** The `nextCursor` of the previous page, still encoded. */
  readonly after?: string;
}

/** A turn this process is running. */
interface ActiveTurn {
  readonly controller: AbortController;
  /** The exchange the turn runs on, for attributing events. */
  readonly exchange: Exchange<unknown>;
  /** Inbox entries the turn consumed at its start. */
  readonly consumed: Set<string>;
  readonly outcome: Promise<AgentResult>;
}

/**
 * The per-context session runtime: one turn at a time per session, an
 * inbox for messages that arrive mid-turn, interrupt, and the boundary
 * turn that consumes what queued.
 *
 * The bound is in-process. Two processes sharing one store are not
 * coordinated: a record whose turn marker was set by a process that is
 * gone is read as a turn a restart cut short, which is the restart rule
 * #716 asks for, and is wrong for a live sibling. One process per store.
 *
 * @internal
 */
export class AgentSessionRuntime {
  private readonly active = new Map<string, ActiveTurn>();
  /** The exchange each in-flight background call was started from. */
  private readonly backgroundOrigins = new Map<string, Exchange<unknown>>();

  constructor(
    private readonly context: CraftContext,
    readonly store: AgentSessionStore,
  ) {}

  /**
   * The runtime for a context, created on first use over the context's
   * suspension store. A context with no `suspension` block has nowhere to
   * keep a transcript, so `session` refuses there rather than running a
   * conversation that forgets itself on restart.
   */
  static for(context: CraftContext): AgentSessionRuntime {
    const existing = context.getStore(ADAPTER_AGENT_SESSIONS);
    if (existing) return existing;
    const suspension = context.getStore(SUSPENSION_RUNTIME);
    if (!suspension) {
      throw rcError("RC5052", undefined, {
        message:
          "agent({ session }) keeps the conversation in the suspension store, and this context has none. Add a `suspension` block to defineConfig (the sqlite backend is the default) so sessions survive a restart.",
      });
    }
    const runtime = new AgentSessionRuntime(
      context,
      new AgentSessionStore(suspension.store),
    );
    context.setStore(ADAPTER_AGENT_SESSIONS, runtime);
    return runtime;
  }

  /** Whether this process is running a turn for the session. */
  isRunning(key: AgentSessionKey): boolean {
    return this.active.has(keyOf(key));
  }

  /**
   * Handle one message for a session: run a turn when the session is
   * idle, queue the message when one is running, and interrupt that turn
   * first when asked to.
   *
   * A queued message is acknowledged, not answered: the reply belongs to
   * the turn that consumes it, which the boundary starts on its own. An
   * interrupting caller waits for that turn and gets its reply, because
   * the interrupt exists so their message is answered now.
   */
  async turn<T>(req: AgentTurnRequest<T>): Promise<AgentResult> {
    const k = keyOf(req.key);
    const running = this.active.get(k);
    if (!running) {
      return this.start(k, req, req.message).outcome;
    }
    const id = randomUUID();
    const record = await this.store.update(req.key, (r) => ({
      ...r,
      inbox: [
        ...r.inbox,
        {
          kind: "message",
          id,
          content: req.message,
          at: new Date().toISOString(),
          ...(req.interrupt ? { interrupt: true } : {}),
        },
      ],
    }));
    this.emit(req.exchange, "route:agent:session:queued", {
      agentName: req.key.agent,
      session: req.key.session,
      depth: record.inbox.length,
      interrupt: req.interrupt,
    });
    if (req.interrupt) {
      running.controller.abort(INTERRUPT_REASON);
      this.emit(req.exchange, "route:agent:session:interrupted", {
        agentName: req.key.agent,
        session: req.key.session,
      });
    } else if (this.active.get(k) === running) {
      return {
        text: "",
        session: {
          agent: req.key.agent,
          id: req.key.session,
          status: "queued",
          queued: record.inbox.length,
        },
      };
    }
    // The turn ended while the message was being written, or this caller
    // interrupted it: either way the message is in the inbox and is
    // answered by whichever turn consumes it. Wait for that turn. A turn
    // that fails propagates whether or not it read the message: one that
    // failed before reaching the inbox failed on the store, and starting
    // another against the same fault would spin.
    for (;;) {
      const current = this.active.get(k) ?? this.start(k, req, undefined);
      const result = await current.outcome;
      if (current.consumed.has(id)) return result;
    }
  }

  /**
   * Append an entry to a session's inbox without starting a turn. The
   * boundary of a running turn delivers it; an idle session delivers it
   * on its next turn.
   */
  async post(
    key: AgentSessionKey,
    entry: DistributiveOmit<AgentInboxMessage, "id" | "at">,
  ): Promise<{ depth: number; running: boolean }> {
    const record = await this.store.update(key, (r) => ({
      ...r,
      inbox: [
        ...r.inbox,
        { ...entry, id: randomUUID(), at: new Date().toISOString() },
      ] as AgentInboxMessage[],
    }));
    return { depth: record.inbox.length, running: this.isRunning(key) };
  }

  /**
   * Record a background tool call the session is waiting on, before the
   * route is dispatched: a crash between the two reports the call lost at
   * the next turn rather than forgetting it ever started.
   */
  async startBackground(
    key: AgentSessionKey,
    call: AgentBackgroundCall,
  ): Promise<void> {
    await this.store.update(key, (r) => ({
      ...r,
      background: [...r.background, call],
    }));
    const turn = this.active.get(keyOf(key));
    // Remembered so the settlement can be attributed to the exchange that
    // started the call, which by then may have finished its turn.
    if (turn) this.backgroundOrigins.set(call.handle, turn.exchange);
    if (turn) {
      this.emit(turn.exchange, "route:agent:session:background:started", {
        agentName: key.agent,
        session: key.session,
        handle: call.handle,
        toolName: call.tool,
      });
    }
  }

  /**
   * Retire a background call and deliver its outcome to the inbox in one
   * write, so a crash between the two cannot lose the result while
   * forgetting the call. The inbox rule applies from here: a running turn
   * sees it at its boundary, an idle session at its next turn.
   */
  async settleBackground(
    key: AgentSessionKey,
    outcome: BackgroundOutcome,
  ): Promise<{ depth: number; running: boolean }> {
    const { duration, ...entry } = outcome;
    // Taken before the write, so a write that fails does not leave the
    // origin behind for a settlement that will never come again.
    const origin = this.backgroundOrigins.get(entry.handle);
    this.backgroundOrigins.delete(entry.handle);
    const record = await this.store.update(key, (r) => ({
      ...r,
      background: r.background.filter((b) => b.handle !== entry.handle),
      inbox: [
        ...r.inbox,
        {
          kind: "background",
          id: randomUUID(),
          at: new Date().toISOString(),
          handle: entry.handle,
          tool: entry.tool,
          status: entry.status,
          ...(entry.status === "completed"
            ? { result: entry.result }
            : {
                error: {
                  ...(entry.error.rc !== undefined
                    ? { rc: entry.error.rc }
                    : {}),
                  message: entry.error.message,
                },
              }),
        },
      ],
    }));
    if (origin) {
      if (entry.status === "completed") {
        this.emit(origin, "route:agent:session:background:completed", {
          agentName: key.agent,
          session: key.session,
          handle: entry.handle,
          toolName: entry.tool,
          duration,
        });
      } else {
        this.emit(origin, "route:agent:session:background:failed", {
          agentName: key.agent,
          session: key.session,
          handle: entry.handle,
          toolName: entry.tool,
          errorName: entry.error.name,
          duration,
        });
      }
    }
    return { depth: record.inbox.length, running: this.isRunning(key) };
  }

  /**
   * One page of the sessions the store knows, for the management API.
   *
   * The index carries every key, so the agent filter and the page are
   * taken on keys alone and only the page's records are read: a listing
   * costs one read per session shown, never one per session stored, and
   * a transcript is never loaded to report a count for a page it is not on.
   */
  async summaries(
    query: AgentSessionListQuery = {},
  ): Promise<OpsPage<AgentSessionSummary>> {
    const scope: CursorScope = {
      fingerprint: JSON.stringify([query.agent ?? null]),
    };
    const after =
      query.after === undefined ? undefined : decodeCursor(query.after, scope);
    const keys = (await this.store.list())
      .filter((key) => query.agent === undefined || key.agent === query.agent)
      .map((key) => ({ id: keyOf(key), key }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const page = takePage(keys, scope, query.limit, after);
    const items: AgentSessionSummary[] = [];
    for (const { key } of page.items) {
      const summary = await this.summary(key);
      if (summary) items.push(summary);
    }
    return page.nextCursor === undefined
      ? { items }
      : { items, nextCursor: page.nextCursor };
  }

  /** One session, or `undefined` when the store has never seen it. */
  async summary(
    key: AgentSessionKey,
  ): Promise<AgentSessionSummary | undefined> {
    const record = await this.store.load(key);
    if (!record) return undefined;
    return {
      agent: record.agent,
      session: record.session,
      turn: this.isRunning(key)
        ? "running"
        : record.turn !== undefined
          ? "stale"
          : "idle",
      inbox: record.inbox.length,
      background: record.background.length,
      messages: record.messages.length,
      turns: record.turns,
      updatedAt: record.updatedAt,
    };
  }

  /**
   * Begin a turn and register it as the session's active one. Synchronous
   * up to the registration so a caller checking `active` in the same tick
   * as a boundary sees the follow-up rather than a gap.
   */
  private start<T>(
    k: string,
    req: AgentTurnRequest<T>,
    incoming: string | LlmPromptPart[] | undefined,
  ): ActiveTurn {
    const controller = new AbortController();
    const consumed = new Set<string>();
    const outcome = this.execute(k, req, incoming, controller, consumed);
    // Observed here so a turn nobody awaits (a boundary follow-up that the
    // route tracks) never surfaces as an unhandled rejection; the waiters
    // that do await it still receive the rejection.
    outcome.catch(() => undefined);
    const turn: ActiveTurn = {
      controller,
      exchange: req.exchange,
      consumed,
      outcome,
    };
    this.active.set(k, turn);
    return turn;
  }

  private async execute<T>(
    k: string,
    req: AgentTurnRequest<T>,
    incoming: string | LlmPromptPart[] | undefined,
    controller: AbortController,
    consumed: Set<string>,
  ): Promise<AgentResult> {
    const { key, exchange, executor } = req;
    let followUp = false;
    let after: AgentSessionRecord | undefined;
    try {
      let lostBackground = 0;
      let stale = false;
      const started = await this.store.update(key, (r) => {
        let next = r;
        if (r.turn !== undefined) {
          // A marker this process did not set: the previous process died
          // mid-turn. The transcript it persisted is kept, every tool call
          // it left open is closed as interrupted, and each background call
          // it was waiting on is reported lost rather than silently dropped.
          stale = true;
          lostBackground = r.background.length;
          next = restoreAfterRestart(r);
        }
        for (const entry of next.inbox) consumed.add(entry.id);
        const user = renderUserMessage(next.inbox, incoming);
        return {
          ...withoutTurn(next),
          messages: [...next.messages, user],
          inbox: [],
          turn: {
            exchangeId: exchange.id,
            startedAt: new Date().toISOString(),
          },
        };
      });
      if (stale) {
        this.emit(exchange, "route:agent:session:restored", {
          agentName: key.agent,
          session: key.session,
          lostBackground,
        });
      }
      const startMessages = started.messages;
      let result: AgentResult;
      try {
        result = await executor.run(
          startMessages,
          controller.signal,
          async (messages) => {
            await this.store.update(key, (r) => ({ ...r, messages }));
          },
        );
      } catch (err) {
        // Whatever stopped the turn, what it reached is kept: the thread
        // is what the next turn starts from, and the marker must not
        // outlive the turn in this process.
        const partial = executor.thread() ?? startMessages;
        after = await this.store.update(key, (r) => ({
          ...withoutTurn(r),
          messages: partial,
        }));
        if (!controller.signal.aborted) throw err;
        followUp = true;
        return {
          text: "",
          session: {
            agent: key.agent,
            id: key.session,
            status: "interrupted",
            queued: after.inbox.length,
          },
        };
      }
      const final = executor.thread() ?? startMessages;
      after = await this.store.update(key, (r) => ({
        ...withoutTurn(r),
        messages: final,
        turns: r.turns + 1,
      }));
      followUp = true;
      return {
        ...result,
        session: {
          agent: key.agent,
          id: key.session,
          status: "replied",
          queued: after.inbox.length,
        },
      };
    } finally {
      this.active.delete(k);
      // The boundary: what queued while the turn ran is delivered now, as
      // the next turn, on the same route so shutdown drains it. Registered
      // before this turn's promise settles, so a waiter never sees the
      // session idle between two turns.
      if (followUp && after !== undefined && after.inbox.length > 0) {
        const next = this.start(k, req, undefined);
        const route = getExchangeRoute(exchange);
        if (route) {
          route.trackTask(next.outcome);
        } else {
          next.outcome.catch((err: unknown) => {
            this.context.logger.error(
              { err, agent: key.agent, session: key.session },
              "Agent session follow-up turn failed",
            );
          });
        }
      }
    }
  }

  private emit<K extends SessionEventName>(
    exchange: Exchange<unknown>,
    name: K,
    details: SessionEventDetails<K>,
  ): void {
    const identity = dispatchIdentityFrom(
      exchange,
      getExchangeRoute(exchange)?.definition.id,
    );
    if (!identity) return;
    // The generic cannot be narrowed per arm inside one method; each
    // caller's `details` is checked against its own event above.
    this.context.emit(name, { ...identity, ...details } as EventDetailsMap[K]);
  }
}

/** How a background call ended, as the tool reports it to the runtime. @internal */
export type BackgroundOutcome = {
  readonly handle: string;
  readonly tool: string;
  readonly duration: number;
} & (
  | { readonly status: "completed"; readonly result: unknown }
  | {
      readonly status: "failed";
      readonly error: {
        readonly rc?: string;
        readonly message: string;
        readonly name: string;
      };
    }
);

type SessionEventName =
  | "route:agent:session:queued"
  | "route:agent:session:interrupted"
  | "route:agent:session:restored"
  | "route:agent:session:background:started"
  | "route:agent:session:background:completed"
  | "route:agent:session:background:failed";

type SessionEventDetails<K extends SessionEventName> = Omit<
  EventDetailsMap[K],
  "routeId" | "exchangeId" | "correlationId"
>;

/** `Omit` that keeps a union a union rather than collapsing it to its common keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** The abort reason an interrupt carries, so a cancelled run can be told from a stopped one. */
const INTERRUPT_REASON = new Error(
  "The session's running turn was interrupted by a later message.",
);
INTERRUPT_REASON.name = "AgentSessionInterrupt";

function keyOf(key: AgentSessionKey): string {
  return `${encodeURIComponent(key.agent)}:${encodeURIComponent(key.session)}`;
}

function withoutTurn(record: AgentSessionRecord): AgentSessionRecord {
  // Destructured rather than set to undefined: the store drops undefined
  // properties, but the record type does not admit one.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit
  const { turn: _turn, ...rest } = record;
  return rest;
}

/**
 * What a record cut short by a restart becomes at the next turn start.
 * See {@link AgentSessionRuntime.execute}.
 */
function restoreAfterRestart(record: AgentSessionRecord): AgentSessionRecord {
  const at = new Date().toISOString();
  const lost: AgentInboxMessage[] = record.background.map((call) => ({
    kind: "background",
    id: randomUUID(),
    handle: call.handle,
    tool: call.tool,
    status: "failed",
    error: {
      message: `The run was lost: the process restarted before it finished (started ${call.startedAt}). Start it again if it is still needed.`,
    },
    at,
  }));
  return {
    ...withoutTurn(record),
    messages: closeUnansweredToolCalls(record.messages),
    inbox: [...record.inbox, ...lost],
    background: [],
  };
}
