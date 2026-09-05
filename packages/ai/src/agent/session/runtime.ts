import { randomUUID } from "node:crypto";
import {
  SUSPENSION_RUNTIME,
  decodeCursor,
  getExchangeRoute,
  rcError,
  reviveSuspension,
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
import { BoundedMap, SESSION_MEMORY_BOUND } from "./bounded.ts";
import { AgentSessionStore } from "./store.ts";
import { sessionStoreOf } from "./config.ts";
import type {
  AgentBackgroundCall,
  AgentInboxMessage,
  AgentSessionKey,
  AgentSessionPark,
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
  /**
   * The caller's message. Absent on a revived continuation, whose turn is
   * the inbox alone: the completion, or the messages that queued.
   */
  readonly message?: string | LlmPromptPart[];
  /** The subject of the exchange's principal, or `null` when it carries none. */
  readonly by: string | null;
  readonly interrupt: boolean;
  readonly executor: AgentTurnExecutor;
  /**
   * Store this exchange's continuation, for a turn that ends with work
   * outstanding. Absent when the step sits where a park cannot be revived
   * from (inside a fan-out), in which case queued messages run in process
   * and a completion waits for the next message.
   */
  readonly park?: (
    announce: (park: AgentSessionPark) => Promise<void>,
  ) => Promise<AgentSessionPark>;
  /** The stored continuation this exchange revives, when it is one. */
  readonly revived?: string;
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
  /** Sessions whose stored continuation is being revived right now. */
  private readonly reviving = new Set<string>();
  /** Callers waiting for the next turn to start on a session. */
  private readonly starters = new Map<string, Set<() => void>>();
  /** Sessions that took a post while their turn was ending. */
  private readonly postedDuring = new Set<string>();
  /**
   * The last request each session ran on here: what an append that lands
   * on an idle session without a continuation runs its turn on.
   */
  private readonly lastRequests = new BoundedMap<
    string,
    AgentTurnRequest<unknown>
  >(SESSION_MEMORY_BOUND);
  /** Revivals started by this process and not yet settled. */
  private readonly revivals = new Set<Promise<unknown>>();
  /** Set at teardown, so the boot drive starts no further revival. */
  private stopping = false;

  constructor(
    private readonly context: CraftContext,
    readonly store: AgentSessionStore,
  ) {}

  /**
   * The runtime for a context, created on first use over the session store
   * the context resolved and its suspension store. Records live in the
   * first; the continuation a turn stores between turns is a parked
   * exchange and lives in the second, so a context with no `suspension`
   * block refuses `session` rather than running conversations whose
   * boundary turns could never be revived.
   */
  static for(context: CraftContext): AgentSessionRuntime {
    const existing = context.getStore(ADAPTER_AGENT_SESSIONS);
    if (existing) return existing;
    const suspension = context.getStore(SUSPENSION_RUNTIME);
    if (!suspension) {
      throw rcError("RC5052", undefined, {
        message:
          "agent({ session }) stores a turn's continuation in the suspension store, and this context has none. Add a `suspension` block to defineConfig (the sqlite backend is the default) so a turn that ends with work outstanding can be revived.",
      });
    }
    const runtime = new AgentSessionRuntime(
      context,
      new AgentSessionStore(sessionStoreOf(context), suspension.store),
    );
    context.setStore(ADAPTER_AGENT_SESSIONS, runtime);
    // Latched as shutdown begins, before the routes drain, so a completion
    // or a post landing during the drain starts no turn on it; the plugin's
    // teardown awaits the same stop() again for the revivals in flight.
    context.on("context:stopping", () => {
      void runtime.stop();
    });
    return runtime;
  }

  /**
   * Stop starting revivals and wait for the ones in flight; called at
   * teardown, before the store they write to is closed.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    // A caller waiting on a revival's start would otherwise sit out the
    // revival bound; woken now, it reads the latch and answers queued.
    for (const waiters of [...this.starters.values()]) {
      for (const notify of [...waiters]) notify();
    }
    await Promise.allSettled([...this.revivals]);
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
    // A continuation revived before shutdown began still runs here, held
    // by stop() until it settles; a caller's message on an idle session
    // after that point is kept in the record for the next process.
    if (!running && (req.message === undefined || !this.stopping)) {
      return this.start(k, req, req.message).outcome;
    }
    if (req.message === undefined) {
      // A revived continuation that found a turn already running: that
      // turn's boundary consumes the inbox, and its end stores a fresh
      // continuation if work is still outstanding. Nothing to run here.
      const depth = (await this.store.load(req.key))?.inbox.length ?? 0;
      return {
        text: "",
        session: {
          agent: req.key.agent,
          id: req.key.session,
          status: "idle",
          queued: depth,
        },
      };
    }
    const id = randomUUID();
    const content = req.message;
    const record = await this.store.update(req.key, (r) => ({
      ...r,
      inbox: [
        ...r.inbox,
        {
          kind: "message",
          id,
          content,
          by: req.by,
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
    if (!running) return this.queued(req.key, record.inbox.length);
    if (req.interrupt) {
      running.controller.abort(INTERRUPT_REASON);
      this.emit(req.exchange, "route:agent:session:interrupted", {
        agentName: req.key.agent,
        session: req.key.session,
      });
    } else if (this.active.get(k) === running) {
      return this.queued(req.key, record.inbox.length);
    }
    // The turn ended while the message was being written, or this caller
    // interrupted it: either way the message is in the inbox and is
    // answered by whichever turn consumes it. Wait for that turn. A turn
    // that fails propagates whether or not it read the message: one that
    // failed before reaching the inbox failed on the store, and starting
    // another against the same fault would spin.
    for (;;) {
      // Once shutdown began, a turn nobody is running must not be started
      // here either: the message is in the record for the next process.
      if (!this.active.has(k) && this.stopping) {
        return this.queued(
          req.key,
          (await this.store.load(req.key))?.inbox.length ?? 0,
        );
      }
      const current = this.active.get(k) ?? (await this.nextTurn(k, req, id));
      if (current === undefined) continue;
      const result = await current.outcome;
      if (current.consumed.has(id)) return result;
      if (this.active.has(k)) continue;
      // The turn ended without reading this message and no follow-up took
      // over. Only a message still in the inbox has a turn to wait for; one
      // that is gone was consumed where this process could not see it, and
      // starting turns until one reads it would never end.
      const inbox = (await this.store.load(req.key))?.inbox ?? [];
      if (!inbox.some((entry) => entry.id === id)) {
        return {
          text: "",
          session: {
            agent: req.key.agent,
            id: req.key.session,
            status: "idle",
            queued: inbox.length,
          },
        };
      }
    }
  }

  /**
   * The turn that will consume a queued message when none is running:
   * the revival of the session's stored continuation when the boundary
   * left one and is reviving it, else one started here. Waiting on the
   * revival is what keeps the boundary turn on the route's own pipeline;
   * a revival that never reaches this runtime (a step ahead of the agent
   * failed) is given up on after a bound and the turn started in process,
   * so a waiting caller is never stranded on it. Nothing once shutdown
   * began while this waited: the caller answers `queued` then.
   */
  private async nextTurn<T>(
    k: string,
    req: AgentTurnRequest<T>,
    messageId: string,
  ): Promise<ActiveTurn | undefined> {
    // Registered before the read: a revival can start its turn while the
    // record is being read, and a waiter registered after that start
    // would wait on one that has already happened.
    const wait = this.awaitStart(k, REVIVAL_WAIT_MS);
    const record = await this.store.load(req.key);
    const already = this.active.get(k);
    if (already) {
      wait.cancel();
      return already;
    }
    const pending =
      record?.park !== undefined &&
      record.inbox.some((entry) => entry.id === messageId);
    if (pending) {
      const started = await wait.started;
      if (started) return started;
    } else {
      wait.cancel();
    }
    const live = this.active.get(k);
    if (live !== undefined || this.stopping) return live;
    return this.start(k, req, undefined);
  }

  /** The acknowledgement of a message left in the inbox for a later turn. */
  private queued(key: AgentSessionKey, depth: number): AgentResult {
    return {
      text: "",
      session: {
        agent: key.agent,
        id: key.session,
        status: "queued",
        queued: depth,
      },
    };
  }

  /** The next turn registered for `k`, or `undefined` at the bound, when cancelled, or at stop(). */
  private awaitStart(
    k: string,
    timeoutMs: number,
  ): { started: Promise<ActiveTurn | undefined>; cancel: () => void } {
    const waiters = this.starters.get(k) ?? new Set();
    this.starters.set(k, waiters);
    let settle!: (turn: ActiveTurn | undefined) => void;
    const started = new Promise<ActiveTurn | undefined>((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const notify = (): void => finish(this.active.get(k));
    const finish = (turn: ActiveTurn | undefined): void => {
      clearTimeout(timer);
      waiters.delete(notify);
      if (waiters.size === 0) this.starters.delete(k);
      settle(turn);
    };
    waiters.add(notify);
    return { started, cancel: () => finish(undefined) };
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
    const running = this.isRunning(key);
    // Landing after the running turn read the inbox for its boundary and
    // before it cleared `active` would otherwise wait for the next
    // message; the turn's cleanup reads the record again for it.
    if (running) this.postedDuring.add(keyOf(key));
    else this.deliverIdle(key, record);
    return { depth: record.inbox.length, running };
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
    // Read before the write: the turn that is making this call can end
    // while the write is awaited, and the origin is that turn's whatever
    // it does next.
    const turn = this.active.get(keyOf(key));
    await this.store.update(key, (r) => ({
      ...r,
      background: [...r.background, call],
    }));
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
   * forgetting the call. A running turn sees it at its boundary; an idle
   * session's stored continuation is revived so the completion starts the
   * next turn on its own, which is what a build finishing is for.
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
    // The record is plain JSON, and a route may answer with anything: a
    // result the store cannot hold is delivered as a failure naming the
    // reason rather than refused at the write, which would leave the call
    // in `background` for good.
    const delivered: Pick<
      Extract<AgentInboxMessage, { kind: "background" }>,
      "status" | "result" | "error"
    > = entry.status === "completed"
      ? encodeResult(entry.result)
      : {
          status: "failed",
          error: {
            ...(entry.error.rc !== undefined ? { rc: entry.error.rc } : {}),
            message: entry.error.message,
          },
        };
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
          by: entry.by,
          ...delivered,
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
    const running = this.isRunning(key);
    // Landing after the running turn read the inbox for its boundary and
    // before it cleared `active` would otherwise wait for the next
    // message; the turn's cleanup reads the record again for it.
    if (running) this.postedDuring.add(keyOf(key));
    else this.deliverIdle(key, record);
    return { depth: record.inbox.length, running };
  }

  /**
   * Drive what a previous process left: for every session with a stored
   * continuation, report the background calls it was waiting on as lost
   * (no process is running them) and revive the continuation so the loss
   * reaches the model as a turn rather than waiting for a message nobody
   * may send. A session with no continuation is left for its next message,
   * which restores it the same way. Bounded by the index; one read per
   * session and writes only where something was outstanding.
   */
  async driveBoot(): Promise<{ revived: number; lostBackground: number }> {
    let revived = 0;
    let lostBackground = 0;
    for (const key of await this.store.list()) {
      // Teardown while the boot is still walking the store: what is not
      // yet driven waits for the next boot, as it did for this one.
      if (this.stopping) break;
      let record = await this.store.load(key);
      if (
        record?.parking !== undefined &&
        record.park?.suspensionId !== record.parking.suspensionId &&
        // A turn running here right now is between its own two writes,
        // which reads exactly like the crash below; it clears the field
        // itself on both its arms.
        !this.active.has(keyOf(key))
      ) {
        // The previous process died between announcing the park and naming
        // it: the park, if it got written, is referenced by nothing else.
        const orphan = record.parking.suspensionId;
        let released = true;
        try {
          await this.store.releasePark(
            orphan,
            "agent session park announced but never named",
          );
        } catch (err: unknown) {
          // The reference is the only way back to this park, so it stays on
          // the record and the next boot tries again. A park the previous
          // process never got as far as writing settles quietly instead.
          released = false;
          this.context.logger.warn(
            {
              err,
              agent: key.agent,
              session: key.session,
              suspensionId: orphan,
            },
            "Agent session continuation left unnamed could not be released; the next boot retries",
          );
        }
        if (released) {
          record = await this.store.update(key, withoutParking);
          this.context.logger.info(
            { agent: key.agent, session: key.session, suspensionId: orphan },
            "Agent session continuation left unnamed by the previous process was released",
          );
        }
      }
      if (record?.park === undefined) continue;
      let next = record;
      if (record.turn !== undefined || record.background.length > 0) {
        lostBackground += record.background.length;
        next = await this.store.update(key, restoreAfterRestart);
        this.context.logger.info(
          {
            agent: key.agent,
            session: key.session,
            lostBackground: record.background.length,
          },
          "Agent session restored at boot: its previous process is gone",
        );
      }
      // Read again after the awaits above: a stop that landed during them
      // must not have a revival started under it.
      if (this.stopping) break;
      if (next.inbox.length > 0) {
        this.revive(key, next.park!);
        revived += 1;
      } else if (next.background.length === 0) {
        await this.releasePark(key, next.park!);
      }
    }
    return { revived, lostBackground };
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
      startedBy: record.startedBy ?? null,
      turn: this.isRunning(key)
        ? "running"
        : record.turn !== undefined
          ? "stale"
          : "idle",
      inbox: record.inbox.length,
      background: record.background.length,
      parked: record.park !== undefined,
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
    for (const notify of this.starters.get(k) ?? []) notify();
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
    // What an append landing on this session while it is idle runs on.
    this.lastRequests.set(k, req as AgentTurnRequest<unknown>);
    this.lastRequests.unpin(k);
    let after: AgentSessionRecord | undefined;
    try {
      let lostBackground = 0;
      let stale = false;
      let empty = false;
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
        // Core has settled the continuation this exchange revives; the
        // record stops naming it, and a fresh one is stored at this turn's
        // end if work is still outstanding.
        if (
          req.revived !== undefined &&
          next.park?.suspensionId === req.revived
        ) {
          next = withoutPark(next);
        }
        if (incoming === undefined && next.inbox.length === 0) {
          // A revival with nothing left to consume: another turn got to
          // the inbox first. No model call for an empty user message.
          empty = true;
          return next;
        }
        for (const entry of next.inbox) consumed.add(entry.id);
        const user = renderUserMessage(next.inbox, incoming, req.by);
        return {
          ...withoutTurn(next),
          // Who started the conversation: the first turn's caller, kept
          // for an operator. Never a gate.
          ...(next.startedBy === undefined ? { startedBy: req.by } : {}),
          messages: [...next.messages, user],
          inbox: [],
          turn: {
            exchangeId: exchange.id,
            startedAt: new Date().toISOString(),
          },
        };
      });
      if (req.revived !== undefined) {
        this.emit(exchange, "route:agent:session:revived", {
          agentName: key.agent,
          session: key.session,
          suspensionId: req.revived,
        });
      }
      if (stale) {
        this.emit(exchange, "route:agent:session:restored", {
          agentName: key.agent,
          session: key.session,
          lostBackground,
        });
      }
      if (empty) {
        after = await this.parkIfOutstanding(req, started);
        return {
          text: "",
          session: {
            agent: key.agent,
            id: key.session,
            status: "idle",
            queued: 0,
          },
        };
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
        const written = await this.store.update(key, (r) => ({
          ...withoutTurn(r),
          messages: partial,
        }));
        if (!controller.signal.aborted) {
          after = written;
          throw err;
        }
        after = await this.parkIfOutstanding(req, written);
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
      after = await this.parkIfOutstanding(
        req,
        await this.store.update(key, (r) => ({
          ...withoutTurn(r),
          messages: final,
          turns: r.turns + 1,
        })),
      );
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
      // The boundary: what queued while the turn ran is delivered now, as
      // the next turn. Through the stored continuation when there is one,
      // so the turn runs on the route's own pipeline and its reply reaches
      // the route's downstream steps; in process otherwise. The session
      // stays marked active until the follow-up is scheduled, so no
      // caller starts a second turn in the gap, and a post that landed
      // after this turn's last read is read from the store again, as
      // often as one lands while the reading goes on.
      let boundary = after;
      while (this.postedDuring.delete(k) && after !== undefined) {
        boundary = (await this.store.load(key).catch(() => undefined)) ?? after;
      }
      // Work outstanding with no continuation stored: the request kept here
      // is the only thing a later append can run its turn on, so it is
      // held through evictions until the session's next turn starts.
      if (
        boundary !== undefined &&
        boundary.park === undefined &&
        (boundary.inbox.length > 0 || boundary.background.length > 0)
      ) {
        this.lastRequests.pin(k);
      }
      if (
        boundary !== undefined &&
        boundary.inbox.length > 0 &&
        !this.stopping
      ) {
        if (boundary.park !== undefined) {
          this.active.delete(k);
          this.revive(key, boundary.park, { k, req });
        } else {
          this.followUpInProcess(k, req);
        }
      } else {
        this.active.delete(k);
      }
    }
  }

  /**
   * Store this exchange's continuation when the turn leaves work
   * outstanding, and settle a stale one when it leaves none. One
   * continuation per session: a turn that ends with work outstanding while
   * one is already stored keeps it, whichever exchange it came from.
   */
  private async parkIfOutstanding<T>(
    req: AgentTurnRequest<T>,
    record: AgentSessionRecord,
  ): Promise<AgentSessionRecord> {
    const outstanding = record.background.length > 0 || record.inbox.length > 0;
    if (!outstanding) {
      if (record.park === undefined) return record;
      await this.releasePark(req.key, record.park);
      return withoutPark(record);
    }
    if (record.park !== undefined || req.park === undefined) return record;
    let park: AgentSessionPark;
    let announced: AgentSessionPark | undefined;
    try {
      // The record names the park before the park exists, so a crash
      // between the two writes leaves a reference the boot releases.
      park = await req.park(async (pending) => {
        announced = pending;
        await this.store.update(req.key, (r) => ({ ...r, parking: pending }));
      });
    } catch (err: unknown) {
      // Without a continuation the queued messages run in process and a
      // completion waits for the next message: the shape sessions had
      // before parks, and the log is what says why this one is on it.
      this.context.logger.error(
        { err, agent: req.key.agent, session: req.key.session },
        "Agent session continuation could not be stored; completions wait for the next message",
      );
      // A failure after the announce may leave a park behind, and the
      // record is about to stop naming it. Settled here rather than left
      // for a boot that will no longer find a reference to it.
      if (announced !== undefined) {
        await this.store
          .releasePark(
            announced.suspensionId,
            "agent session park announced but never named",
          )
          .catch(() => undefined);
      }
      return await this.store
        .update(req.key, withoutParking)
        .catch(() => withoutParking(record));
    }
    let updated: AgentSessionRecord;
    try {
      updated = await this.store.update(req.key, (r) => ({
        ...withoutParking(r),
        park,
      }));
    } catch (err: unknown) {
      // Nothing names the continuation now, so nothing will ever revive
      // it; settled before the store failure reaches the caller.
      await this.store
        .releasePark(park.suspensionId, "agent session record write failed")
        .catch(() => undefined);
      throw err;
    }
    this.emit(req.exchange, "route:agent:session:parked", {
      agentName: req.key.agent,
      session: req.key.session,
      suspensionId: park.suspensionId,
      inbox: updated.inbox.length,
      background: updated.background.length,
    });
    return updated;
  }

  /** Settle a continuation nothing will revive and drop it from the record. */
  private async releasePark(
    key: AgentSessionKey,
    park: AgentSessionPark,
  ): Promise<void> {
    await this.store.releasePark(park.suspensionId, "agent session idle");
    await this.store.update(key, (r) =>
      r.park?.suspensionId === park.suspensionId ? withoutPark(r) : r,
    );
  }

  /**
   * Revive a session's stored continuation on this process: core resumes
   * the parked exchange at the agent step, the step runs the next turn
   * from the inbox, and the route's downstream steps follow. At most one
   * revival per session at a time, and none while a turn is running here,
   * because that turn's boundary does this itself.
   *
   * A revival that fails (the route is gone, its continuation changed, the
   * store refused) is logged and the record stops naming the park; the
   * queued messages then run in process when a caller is waiting on them,
   * and otherwise wait for the next message.
   */
  private revive<T>(
    key: AgentSessionKey,
    park: AgentSessionPark,
    fallback?: { k: string; req: AgentTurnRequest<T> },
  ): void {
    const k = keyOf(key);
    if (this.stopping || this.reviving.has(k) || this.active.has(k)) return;
    const suspension = this.context.getStore(SUSPENSION_RUNTIME);
    if (!suspension) return;
    this.reviving.add(k);
    const token = suspension.signer.mint(park.suspensionId, new Date());
    const run = reviveSuspension(this.context, { token, result: undefined })
      .catch(async (err: unknown) => {
        this.context.logger.error(
          {
            err,
            agent: key.agent,
            session: key.session,
            suspensionId: park.suspensionId,
            routeId: park.routeId,
          },
          "Agent session continuation could not be revived",
        );
        // Settled as well as dropped: a record the session no longer names
        // would otherwise stay live in the store with nothing to revive it.
        await this.releasePark(key, park).catch(() => undefined);
        if (fallback && !this.active.has(k)) {
          this.followUpInProcess(fallback.k, fallback.req);
        }
      })
      .finally(() => {
        this.reviving.delete(k);
        this.revivals.delete(run);
      });
    // Held until settled, so a teardown waits for the store writes a
    // revival makes rather than closing the store under them.
    this.revivals.add(run);
  }

  /**
   * An append that landed on an idle session must not wait for another
   * caller: the stored continuation is revived when there is one, and
   * otherwise the turn is started in process on the last request this
   * process ran for the session, as a boundary without a park would.
   */
  private deliverIdle(key: AgentSessionKey, record: AgentSessionRecord): void {
    // Once shutdown began the append stays in the record for the next
    // process: a turn started now would run on a context being drained.
    if (this.stopping) return;
    const k = keyOf(key);
    const last = this.lastRequests.get(k);
    if (record.park !== undefined) {
      this.revive(key, record.park, last ? { k, req: last } : undefined);
    } else if (record.inbox.length > 0 && last && !this.active.has(k)) {
      this.followUpInProcess(k, last);
    }
  }

  /** The boundary turn without a continuation: started here, tracked by the route for drain. */
  private followUpInProcess<T>(k: string, req: AgentTurnRequest<T>): void {
    // A revival that failed after shutdown began lands here too; the
    // messages stay in the record, as on every other path once stopping.
    if (this.stopping) return;
    const next = this.start(k, req, undefined);
    const route = getExchangeRoute(req.exchange);
    if (route) {
      route.trackTask(next.outcome);
    } else {
      next.outcome.catch((err: unknown) => {
        this.context.logger.error(
          { err, agent: req.key.agent, session: req.key.session },
          "Agent session follow-up turn failed",
        );
      });
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
  /** The subject whose turn started the call, or `null`. */
  readonly by: string | null;
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
  | "route:agent:session:parked"
  | "route:agent:session:revived"
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

function withoutPark(record: AgentSessionRecord): AgentSessionRecord {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit
  const { park: _park, ...rest } = record;
  return rest;
}

function withoutParking(record: AgentSessionRecord): AgentSessionRecord {
  if (record.parking === undefined) return record;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit
  const { parking: _parking, ...rest } = record;
  return rest;
}

/**
 * How long a caller waiting on a queued message gives the boundary's
 * revival to reach this runtime before starting the turn itself.
 */
const REVIVAL_WAIT_MS = 30_000;

/**
 * A route's result as the record can hold it: the value after a JSON round
 * trip, or a failure saying why there is none (a BigInt, a cycle, a value
 * that serialises to nothing).
 */
function encodeResult(
  result: unknown,
): Pick<
  Extract<AgentInboxMessage, { kind: "background" }>,
  "status" | "result" | "error"
> {
  try {
    // A non-finite number serialises as null, which would read as a
    // result the route never produced; refused here as the suspension
    // serializer refuses it.
    const text = JSON.stringify(result, (_key, value: unknown) =>
      typeof value === "number" && !Number.isFinite(value)
        ? (() => {
            throw new Error(
              `a non-finite number (${String(value)}) has no JSON form`,
            );
          })()
        : value,
    );
    return {
      status: "completed",
      result: text === undefined ? null : (JSON.parse(text) as unknown),
    };
  } catch (err: unknown) {
    return {
      status: "failed",
      error: {
        message: `The route finished, but its result could not be stored for the session: ${err instanceof Error ? err.message : String(err)}. Return plain JSON from a background route.`,
      },
    };
  }
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
    by: call.by,
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
