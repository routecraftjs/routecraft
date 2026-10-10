import { randomUUID } from "node:crypto";
import {
  CONTINUATIONS,
  anySignal,
  authorityOf,
  decodeCursor,
  deferralScope,
  deferredPrincipal,
  getExchangeRoute,
  rcCodeOf,
  rcError,
  reidentificationDeviation,
  reviveDeferral,
  takePage,
  type Authority,
  type CraftContext,
  type CursorScope,
  type Deferral,
  type DeferralRuntime,
  type EventDetailsMap,
  type EventHandler,
  type EventName,
  type Exchange,
  type ExchangeScoped,
  type OpsPage,
  type PluginLogger,
  type Principal,
  type ResumeAcknowledgment,
  type ResumeRequest,
  type RevivalOptions,
} from "@routecraft/routecraft";
import type { LlmPromptPart } from "../../llm/types.ts";
import { dispatchIdentityFrom } from "../run.ts";
import { assertOverridesAdvertised } from "../advertised.ts";
import { isDownstreamDeferred } from "../downstream-deferred.ts";
import { errorMessage, errorName } from "../error-text.ts";
import { AGENTS } from "../port.ts";
import { ADAPTER_AGENT_SESSIONS } from "../store.ts";
import type { ThreadMessage } from "../deferral-state.ts";
import { AgentHeadersKeys } from "../tools/headers.ts";
import type { AgentRegisteredOptions, AgentResult } from "../types.ts";
import { closeUnansweredToolCalls, renderUserMessage } from "./render.ts";
import { BoundedMap, SESSION_MEMORY_BOUND } from "./bounded.ts";
import { AgentSessionStore, emptyAgentSession } from "./store.ts";
import { sessionStoreOf } from "./config.ts";
import type { ResolvedSessionStore } from "./port.ts";
import type {
  AgentBackgroundCall,
  AgentInboxMessage,
  AgentSessionKey,
  AgentSessionOverrides,
  AgentSessionDeferral,
  AgentSessionRecord,
  AgentSessionScope,
  AgentSessionSummary,
  ReidentifyHook,
} from "./types.ts";

/**
 * What the session runtime needs from the application it runs in. The agent
 * runtime builds one from its plugin context; the inline fallback builds
 * one from the context, so the runtime itself reaches neither.
 *
 * @internal
 */
export interface SessionHost {
  readonly logger: PluginLogger;
  emit<K extends EventName>(event: K, details: EventDetailsMap[K]): void;
  /** Subscribe to an event for the application's lifetime. */
  observe<K extends EventName>(event: K, handler: EventHandler<K>): void;
  /** The continuations store, which holds a turn between messages. */
  continuations(): DeferralRuntime | undefined;
  /**
   * Revive a stored continuation by its token, as the parked principal
   * re-verified live when `options.reidentified` carries one.
   */
  resume(
    request: ResumeRequest,
    options?: RevivalOptions,
  ): Promise<ResumeAcknowledgment>;
  /** A registered agent, for the overrides it advertises. */
  agent(name: string): AgentRegisteredOptions | undefined;
  /** The application's authority, which brands principals and reads them. */
  authority(): Authority;
  /** The application's re-identification hook, when one is registered. */
  reidentify(): ReidentifyHook | undefined;
}

/**
 * The session host for a running context.
 *
 * @internal
 */
export function sessionHostOf(context: CraftContext): SessionHost {
  return {
    logger: context.logger,
    emit: (event, details) => context.emit(event, details),
    observe: (event, handler) => {
      context.on(event, handler);
    },
    continuations: () => context.lookup(CONTINUATIONS),
    resume: (request, options) => reviveDeferral(context, request, options),
    agent: (name) => context.lookup(AGENTS)?.agents.get(name),
    authority: () => authorityOf(context),
    reidentify: () => context.lookup(AGENTS)?.reidentify,
  };
}

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
    /**
     * What the conversation chose about how it runs, read from the record
     * at the start of THIS turn. Passed per run rather than captured when
     * the executor was built, because a boundary turn reuses the executor
     * and must pick up a change made while the previous turn was running.
     */
    overrides: AgentSessionOverrides | undefined,
  ): Promise<AgentResult>;
  /** The thread the last `run` reached, complete or partial. */
  thread(): readonly ThreadMessage[] | undefined;
}

/** One dispatch that carries a session. @internal */
export interface AgentTurnRequest<T = unknown> {
  readonly key: AgentSessionKey;
  /**
   * The agent answering this turn. Not part of the key: a session id is
   * the identity on its own, and this is what the record's
   * `agent` field is set to.
   */
  readonly agent: string;
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
   * outstanding. Absent when the step sits where a deferral cannot be revived
   * from (inside a fan-out), in which case queued messages run in process
   * and a completion waits for the next message.
   */
  readonly defer?: (
    announce: (deferral: AgentSessionDeferral) => Promise<void>,
  ) => Promise<AgentSessionDeferral>;
  /** The stored continuation this exchange revives, when it is one. */
  readonly revived?: string;
  /**
   * Keep this dispatch open when its message queues behind a running
   * turn, and answer it with the result of the turn that consumes the
   * message, rather than acknowledging `queued` at once.
   *
   * For a caller that is itself holding a request open: an editor's
   * `session/prompt` has to stay open until the reply has streamed, or
   * the editor shows the message finished with nothing under it.
   */
  readonly hold?: boolean;
}

/** What a caller asks of the session listing. @internal */
export interface AgentSessionListQuery {
  /**
   * Whose sessions to list. Required rather than defaulted, so a new
   * caller has to decide between one owner's view and the operator's
   * rather than inheriting the wider one by omission.
   */
  readonly scope: AgentSessionScope;
  /** Only this agent's sessions. */
  readonly agent?: string;
  /** Only sessions bound to this directory. */
  readonly cwd?: string;
  /** Page size; the mount's default and bound apply. */
  readonly limit?: number;
  /** The `nextCursor` of the previous page, still encoded. */
  readonly after?: string;
}

/** What a session is opened with, before its first turn. @internal */
export interface AgentSessionInit {
  /** Who the conversation belongs to, or `null` for an unauthenticated opener. */
  readonly owner: string | null;
  /** The directory it is bound to, absolute. */
  readonly cwd?: string;
  readonly title?: string;
}

/** A turn this process is running. */
interface ActiveTurn {
  /** Minted per turn: an exchange runs several turns, so its id cannot name one. */
  readonly id: string;
  readonly controller: AbortController;
  /** The exchange the turn runs on, for attributing events. */
  readonly exchange: Exchange<unknown>;
  /** Inbox entries the turn consumed at its start. */
  readonly consumed: Set<string>;
  readonly outcome: Promise<AgentResult>;
}

/**
 * The refusal for a session in an application with no continuations store.
 *
 * @internal
 */
export function noContinuationsStore(): Error {
  return rcError("RC5052", undefined, {
    message:
      "agent({ session }) stores a turn's continuation in the deferral store, and this application has no deferral runtime. Add deferral: {} to defineProject (or defineConfig) to take the defaults, or deferral: { store, secret } to be explicit.",
  });
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
  /**
   * The deferral each revived exchange this process is running came from,
   * by exchange id, from `route:exchange:resumed` until the run's terminal
   * event. What tells a terminal event apart as execution two of a parked
   * background call, and as that run's own rather than a split child's.
   */
  private readonly resumedRuns = new Map<string, string>();
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
  /** Aborted at teardown, so a `reidentify` hook still running does not hold `stop()`. */
  private readonly halt = new AbortController();
  /**
   * Background calls this process dispatched and has not yet settled. Live
   * here even when the record says nothing has parked them, so a boot drive
   * still walking the store does not report them lost.
   */
  private readonly startedHere = new Set<string>();

  constructor(
    private readonly host: SessionHost,
    readonly store: AgentSessionStore,
  ) {}

  /**
   * The runtime an application's agents share. With the agent runtime
   * installed it is the one its registry holds; an application with only
   * inline agents gets one bound to the context on first use.
   *
   * @throws RC5052 when the application has no continuations store
   */
  static for(context: CraftContext): AgentSessionRuntime {
    const agents = context.lookup(AGENTS);
    if (agents) return agents.sessions();
    const existing = context.getStore(ADAPTER_AGENT_SESSIONS);
    if (existing) return existing;
    const runtime = AgentSessionRuntime.create(
      sessionHostOf(context),
      sessionStoreOf(context),
    );
    context.setStore(ADAPTER_AGENT_SESSIONS, runtime);
    // Latched as shutdown begins, before the routes drain, so a completion
    // or a post landing during the drain starts no turn on it; closing the
    // store awaits the same stop() again for the revivals in flight.
    context.on("context:stopping", () => {
      void runtime.stop();
    });
    return runtime;
  }

  /**
   * A runtime over a resolved session store and the continuations store.
   * Records live in the first; the continuation a turn stores between
   * turns is a deferred exchange and lives in the second, so an application
   * with no `deferral` block refuses `session` rather than running
   * conversations whose boundary turns could never be revived. The runtime
   * is retained on the store, so closing the store stops it first.
   *
   * @throws RC5052 when the host has no continuations store
   */
  static create(
    host: SessionHost,
    store: ResolvedSessionStore,
  ): AgentSessionRuntime {
    const deferral = host.continuations();
    if (!deferral) throw noContinuationsStore();
    const runtime = new AgentSessionRuntime(
      host,
      new AgentSessionStore(store.store, deferral.store),
    );
    runtime.listen();
    store.retain(runtime);
    return runtime;
  }

  /**
   * Settle a parked background call from the event bus. The dispatch that
   * started the call resolves with execution one's body, and for a route
   * that parks that body is the `Deferred` acknowledgment, not the result:
   * the run that carries the result is execution two, which only the bus
   * reports. The handle and the session ride the exchange's headers and
   * survive the park with them, so execution two's terminal event names
   * the handle it was dispatched under on whichever process runs it.
   *
   * Only a resumed run is read here. `route:exchange:resumed` fires on the
   * process that runs the continuation, just ahead of its `started`, and
   * names the exchange, so a terminal event is matched on that id: a run
   * that did not park is settled by its dispatch, and a split child of a
   * resumed run, which inherits the headers under its own id, settles
   * nothing. A continuation that parks again keeps the handle open and
   * moves the recorded deferral to the new park. An expiry carries no
   * snapshot, so it reads the handle and the session off the deferral
   * record's stored headers, which still exist when the event fires.
   */
  private listen(): void {
    this.host.observe("route:exchange:resumed", ({ details }) => {
      this.resumedRuns.set(details.exchangeId, details.deferralId);
    });
    this.host.observe("route:exchange:completed", ({ details }) => {
      this.settleResumed(details.exchangeId, details.exchange, () =>
        outcomeOfResult(details.exchange?.body),
      );
    });
    this.host.observe("route:exchange:failed", ({ details }) => {
      this.settleResumed(details.exchangeId, details.exchange, () => ({
        status: "failed",
        error: errorOf(details.error),
      }));
    });
    this.host.observe("route:exchange:dropped", ({ details }) => {
      this.settleResumed(details.exchangeId, details.exchange, () =>
        droppedOutcome(details.reason),
      );
    });
    this.host.observe("route:exchange:deferred", ({ details }) => {
      const prior = this.resumedRuns.get(details.exchangeId);
      // Execution one's own terminal event: core runs the notify hook after
      // the store write and before this event, so a fast resume can land
      // first. A real re-park always mints a new id.
      if (prior === undefined || prior === details.deferralId) return;
      this.resumedRuns.delete(details.exchangeId);
      this.track(this.reparkBackground(details.deferralId), {
        deferralId: prior,
        next: details.deferralId,
      });
    });
    this.host.observe("route:exchange:expired", ({ details }) => {
      this.track(
        this.settleParked(
          details.deferralId,
          expiredOutcome(details.deferralId, details.expiresAt),
        ),
        { deferralId: details.deferralId },
      );
    });
    this.host.observe("route:exchange:denied", ({ details }) => {
      this.track(this.settleDenied(details.deferralId, details.reason), {
        deferralId: details.deferralId,
      });
    });
  }

  /** Settle the handle a resumed run's terminal event names, when it names one. */
  private settleResumed(
    exchangeId: string,
    snapshot: { headers: Record<string, unknown> } | undefined,
    outcome: () => BackgroundRunOutcome,
  ): void {
    if (!this.resumedRuns.delete(exchangeId)) return;
    const call = snapshot && backgroundCallOf(snapshot.headers);
    if (!call) return;
    this.track(
      this.settleBackground(call.session, {
        handle: call.handle,
        ...outcome(),
      }),
      call,
    );
  }

  /**
   * Settle the call parked on a deferral that was denied, which emits
   * neither `resumed` nor `expired`: a redeploy that changed the route after
   * the park (`RC5048`), an operator's cancellation. The continuation will
   * never run, so the call fails with `RC5050` naming the reason.
   *
   * Registered on `route:exchange:denied`.
   */
  private settleDenied(
    deferralId: string,
    reason: string | undefined,
  ): Promise<{ depth: number; running: boolean } | undefined> {
    return this.settleParked(deferralId, deniedOutcome(deferralId, reason));
  }

  /**
   * Observe a background settlement nobody awaits. The settlement writes the
   * session record, and that write can fail (a store outage, a
   * compare-and-swap that never wins); a failure is logged, because the
   * model is waiting on a result that is now lost and nothing else will say
   * so. The one place that line is written, whether the settlement came
   * from the dispatch or from the bus.
   *
   * @param bindings What identifies the call in the log line: the session,
   *   and the handle, tool and agent where the caller knows them.
   * @internal
   */
  track(
    settlement: Promise<unknown>,
    bindings: Readonly<Record<string, unknown>>,
  ): void {
    settlement.catch((err: unknown) => {
      this.host.logger.error(
        { err, ...bindings },
        "Background tool result could not be delivered to the session inbox",
      );
    });
  }

  /**
   * Stop starting revivals and wait for the ones in flight; called at
   * teardown, before the store they write to is closed.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.halt.abort();
    // A caller waiting on a revival's start would otherwise sit out the
    // revival bound; woken now, it reads the latch and answers queued.
    for (const waiters of [...this.starters.values()]) {
      for (const notify of [...waiters]) notify();
    }
    await Promise.allSettled([...this.revivals]);
  }

  /**
   * Whether a background call is lost to a restart: its route never parked,
   * so only the process that dispatched it could settle it, and that is not
   * this one.
   */
  private lostHere(call: AgentBackgroundCall): boolean {
    return !isParked(call) && !this.startedHere.has(call.handle);
  }

  /** Whether this process is running a turn for the session. */
  isRunning(key: AgentSessionKey): boolean {
    return this.active.has(key);
  }

  /**
   * The id of the turn this process is running for the session right now,
   * or `undefined` when it runs none. What a delta or a tool event emitted
   * during a turn belongs to, for a consumer that attributes output per
   * turn rather than per exchange.
   */
  turnIdOf(key: AgentSessionKey): string | undefined {
    return this.active.get(key)?.id;
  }

  /**
   * Handle one message for a session: run a turn when the session is
   * idle, queue the message when one is running, and interrupt that turn
   * first when asked to.
   *
   * A queued message is acknowledged, not answered: the reply belongs to
   * the turn that consumes it, which the boundary starts on its own. An
   * interrupting caller waits for that turn and gets its reply, because
   * the interrupt exists so their message is answered now. A caller that
   * asked to `hold` waits the same way without interrupting, so several
   * messages queued behind one turn are answered together by the boundary
   * turn and every one of their callers receives that reply.
   */
  async turn<T>(req: AgentTurnRequest<T>): Promise<AgentResult> {
    const k = req.key;
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
          agent: req.agent,
          id: req.key,
          status: "idle",
          queued: depth,
        },
      };
    }
    const id = randomUUID();
    const content = req.message;
    const record = await this.write(req.key, req.agent, (r) => ({
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
      agentName: req.agent,
      session: req.key,
      depth: record.inbox.length,
      interrupt: req.interrupt,
    });
    if (!running) return this.queued(req.key, req.agent, record.inbox.length);
    if (req.interrupt) {
      running.controller.abort(INTERRUPT_REASON);
      // Scoped to the turn that was interrupted, not to the message that
      // interrupted it. A listener acting on this event acts on the turn
      // being stopped, and the interrupter's own exchange is the one that
      // carries on.
      this.emit(running.exchange, "route:agent:session:interrupted", {
        agentName: req.agent,
        session: req.key,
      });
    } else if (this.active.get(k) === running && req.hold !== true) {
      return this.queued(req.key, req.agent, record.inbox.length);
    }
    // The turn ended while the message was being written, this caller
    // interrupted it, or this caller holds: either way the message is in
    // the inbox and is answered by whichever turn consumes it. Wait for
    // that turn. A turn
    // that fails propagates whether or not it read the message: one that
    // failed before reaching the inbox failed on the store, and starting
    // another against the same fault would spin.
    for (;;) {
      // Once shutdown began, a turn nobody is running must not be started
      // here either: the message is in the record for the next process.
      if (!this.active.has(k) && this.stopping) {
        return this.queued(
          req.key,
          req.agent,
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
            agent: req.agent,
            id: req.key,
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
      record?.deferral !== undefined &&
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
  private queued(
    key: AgentSessionKey,
    agent: string,
    depth: number,
  ): AgentResult {
    return {
      text: "",
      session: {
        agent,
        id: key,
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
    agent: string,
    entry: DistributiveOmit<AgentInboxMessage, "id" | "at">,
  ): Promise<{ depth: number; running: boolean }> {
    const record = await this.write(key, agent, (r) => ({
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
    if (running) this.postedDuring.add(key);
    else this.deliverIdle(key, record, "append");
    return { depth: record.inbox.length, running };
  }

  /**
   * Record a background tool call the session is waiting on, before the
   * route is dispatched: a crash between the two reports the call lost at
   * the next turn rather than forgetting it ever started.
   */
  async startBackground(
    key: AgentSessionKey,
    agent: string,
    call: AgentBackgroundCall,
  ): Promise<void> {
    // Read before the write: the turn that is making this call can end
    // while the write is awaited, and the origin is that turn's whatever
    // it does next.
    const turn = this.active.get(key);
    // Written on the record so the settlement is attributed to the
    // exchange that started the call, which by then may have finished its
    // turn, or run on a process that is gone.
    const origin = turn ? identityOf(turn.exchange) : undefined;
    this.startedHere.add(call.handle);
    let record: AgentSessionRecord;
    try {
      record = await this.write(key, agent, (r) => ({
        ...r,
        background: [
          ...r.background,
          { ...call, ...(origin ? { origin } : {}) },
        ],
      }));
    } catch (err: unknown) {
      this.startedHere.delete(call.handle);
      throw err;
    }
    if (origin) {
      this.emitAt(origin, "route:agent:session:background:started", {
        agentName: record.agent,
        session: key,
        handle: call.handle,
        toolName: call.tool,
      });
    }
  }

  /**
   * Record that a background call's dispatch answered with a `Deferred`
   * acknowledgment, so the call stays open until execution two settles it
   * and an expiry can find it.
   *
   * The link is the handle on the parked exchange's stored headers, not
   * the acknowledgment: the route that parked is the one whose execution
   * two will carry the handle, whether it is the dispatched route or one
   * it forwarded to with the headers. A deferral whose exchange does not
   * carry the handle is a park this handle cannot track (a route that
   * completed with another route's acknowledgment as its body), and the
   * call settles as failed with `AI1006` rather than waiting for a run
   * that will never name it. A handle execution two already settled is
   * left alone: a decision can land before the acknowledgment that
   * announced the park is even read.
   */
  async parkBackground(
    key: AgentSessionKey,
    handle: string,
    deferralId: string,
  ): Promise<void> {
    const parked = await this.host.continuations()?.store.get(deferralId);
    if (
      parked?.exchange.headers[AgentHeadersKeys.BACKGROUND_HANDLE] !== handle
    ) {
      await this.settleBackground(key, { handle, ...unlinkedParkOutcome() });
      return;
    }
    await this.recordPark(key, handle, deferralId);
  }

  /**
   * Retire a background call and deliver its outcome to the inbox in one
   * write, so a crash between the two cannot lose the result while
   * forgetting the call. A running turn sees it at its boundary; an idle
   * session's stored continuation is revived so the completion starts the
   * next turn on its own, which is what a build finishing is for.
   *
   * Settles at most once: a handle the record no longer holds answers
   * `undefined` and writes nothing, so the event that ended the run and a
   * dispatch that rejected without one can both report it, and whichever
   * lands first is the settlement.
   */
  async settleBackground(
    key: AgentSessionKey,
    outcome: BackgroundOutcome,
  ): Promise<{ depth: number; running: boolean } | undefined> {
    const current = await this.store.load(key);
    const call = current?.background.find((b) => b.handle === outcome.handle);
    if (!current || !call) return undefined;
    const at = new Date().toISOString();
    let settled = false;
    const record = await this.write(key, current.agent, (r) => {
      settled = r.background.some((b) => b.handle === outcome.handle);
      if (!settled) return r;
      return {
        ...r,
        background: r.background.filter((b) => b.handle !== outcome.handle),
        inbox: [...r.inbox, settlementEntry(call, outcome, at)],
      };
    });
    if (!settled) return undefined;
    this.startedHere.delete(outcome.handle);
    this.announceSettled(key, record.agent, call, outcome);
    const running = this.isRunning(key);
    // Landing after the running turn read the inbox for its boundary and
    // before it cleared `active` would otherwise wait for the next
    // message; the turn's cleanup reads the record again for it.
    if (running) this.postedDuring.add(key);
    else this.deliverIdle(key, record, "settlement");
    return { depth: record.inbox.length, running };
  }

  /**
   * Settle the background call parked on a deferral, named by the handle
   * and the session on the parked exchange's stored headers: an expiry and
   * a denial carry no exchange snapshot, and the record still exists when
   * either is announced. One read; a deferral whose exchange carries no
   * handle settles nothing.
   */
  private async settleParked(
    deferralId: string,
    outcome: BackgroundRunOutcome,
  ): Promise<{ depth: number; running: boolean } | undefined> {
    const stored = await this.host.continuations()?.store.get(deferralId);
    const call = stored && backgroundCallOf(stored.exchange.headers);
    if (!call) return undefined;
    return this.settleBackground(call.session, {
      ...outcome,
      handle: call.handle,
    });
  }

  /**
   * Move a parked call to the deferral its continuation parked on again,
   * read off that deferral's stored headers, so a boot after the second
   * park reconciles against the record that is still waiting.
   */
  private async reparkBackground(next: string): Promise<void> {
    const stored = await this.host.continuations()?.store.get(next);
    const call = stored && backgroundCallOf(stored.exchange.headers);
    if (!call) return;
    await this.recordPark(call.session, call.handle, next);
  }

  /** Name the deferral a call parked on beside its handle, when the call is still open. */
  private async recordPark(
    key: AgentSessionKey,
    handle: string,
    deferralId: string,
  ): Promise<void> {
    const record = await this.store.load(key);
    if (!record) return;
    await this.write(key, record.agent, (r) =>
      r.background.some((b) => b.handle === handle)
        ? {
            ...r,
            background: r.background.map((b) =>
              b.handle === handle ? { ...b, deferralId } : b,
            ),
          }
        : r,
    );
  }

  /**
   * What became of each parked call while no process was watching it, read
   * from the deferral it parked on: still `waiting` keeps it; `resumed`
   * settles it from the continuation's recorded outcome, or reports it lost
   * when execution two died before recording one; `expired` fails it with
   * `RC5047`, `denied` with `RC5050` and the stored reason; a record that is
   * gone reports it lost. A continuation that parked again keeps it too:
   * the new park is not named on the old record, and its own events settle
   * the call by handle.
   *
   * A call whose execution two this process is running is kept, and a
   * deferral the store cannot read right now is kept for the next boot
   * rather than reported lost on a transient fault.
   *
   * @returns A verdict per handle to retire; a call absent from it is kept
   */
  private async reconcileParked(
    key: AgentSessionKey,
    calls: readonly AgentBackgroundCall[],
  ): Promise<ReadonlyMap<string, ParkVerdict>> {
    const verdicts = new Map<string, ParkVerdict>();
    const store = this.host.continuations()?.store;
    if (!store) return verdicts;
    const running = new Set(this.resumedRuns.values());
    for (const call of calls) {
      const deferralId = call.deferralId;
      if (deferralId === undefined || running.has(deferralId)) continue;
      let parked: Deferral | undefined;
      try {
        parked = await store.get(deferralId);
      } catch (err: unknown) {
        this.host.logger.warn(
          { err, session: key, handle: call.handle, deferralId },
          "Parked background call could not be reconciled with its deferral; the next boot retries",
        );
        continue;
      }
      const verdict = parkVerdict(deferralId, parked);
      if (verdict !== undefined) verdicts.set(call.handle, verdict);
    }
    return verdicts;
  }

  /** Announce a call a reconciliation retired with an outcome, as a live settlement would. */
  private announceSettled(
    key: AgentSessionKey,
    agent: string,
    call: AgentBackgroundCall,
    outcome: BackgroundRunOutcome,
  ): void {
    if (!call.origin) return;
    const started = Date.parse(call.startedAt);
    const duration = Number.isNaN(started) ? 0 : Date.now() - started;
    if (outcome.status === "completed") {
      this.emitAt(call.origin, "route:agent:session:background:completed", {
        agentName: agent,
        session: key,
        handle: call.handle,
        toolName: call.tool,
        duration,
      });
    } else {
      this.emitAt(call.origin, "route:agent:session:background:failed", {
        agentName: agent,
        session: key,
        handle: call.handle,
        toolName: call.tool,
        errorName: outcome.error.name,
        duration,
      });
    }
  }

  /**
   * Drive what a previous process left. Every parked call is reconciled
   * against its deferral record ({@link reconcileParked}), so a decision,
   * an expiry or a denial that landed while no process watched is delivered
   * rather than waited on for ever. For every session with a stored
   * continuation, the background calls that never parked are reported lost
   * (no process is running them) and the continuation is revived, so the
   * outcome reaches the model as a turn rather than waiting for a message
   * nobody may send; a revival that carries a settlement, reconciled here or
   * left in the inbox by a settlement wake that never got through,
   * re-identifies the parked principal first, as a live settlement does
   * ({@link awaitsSettlementWake}). A session with no
   * continuation is left for its next message, which restores it the same
   * way. Bounded by the index; one read per session, one per parked call,
   * and writes only where something was outstanding.
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
        record?.deferring !== undefined &&
        record.deferral?.deferralId !== record.deferring.deferralId &&
        // A turn running here right now is between its own two writes,
        // which reads exactly like the crash below; it clears the field
        // itself on both its arms.
        !this.active.has(key)
      ) {
        // The previous process died between announcing the deferral and naming
        // it: the deferral, if it got written, is referenced by nothing else.
        const orphan = record.deferring.deferralId;
        let released = true;
        try {
          await this.store.releaseDeferral(
            orphan,
            "agent session deferral announced but never named",
          );
        } catch (err: unknown) {
          // The reference is the only way back to this deferral, so it stays on
          // the record and the next boot tries again. A deferral the previous
          // process never got as far as writing settles quietly instead.
          released = false;
          this.host.logger.warn(
            {
              err,
              agent: record.agent,
              session: key,
              deferralId: orphan,
            },
            "Agent session continuation left unnamed could not be released; the next boot retries",
          );
        }
        if (released) {
          // Only if the field still names what was released: a turn that
          // started during the release above announced its own, and that
          // one is live.
          record = await this.write(key, record.agent, (current) =>
            current.deferring?.deferralId === orphan
              ? withoutDeferring(current)
              : current,
          );
          this.host.logger.info(
            { agent: record.agent, session: key, deferralId: orphan },
            "Agent session continuation left unnamed by the previous process was released",
          );
        }
      }
      if (record === undefined) continue;
      const parked = record.background.filter(isParked);
      const verdicts =
        parked.length > 0 && !this.active.has(key)
          ? await this.reconcileParked(key, parked)
          : NO_VERDICTS;
      const lostHere = (call: AgentBackgroundCall): boolean =>
        this.lostHere(call);
      const restore =
        record.deferral !== undefined &&
        (record.turn !== undefined || record.background.some(lostHere));
      let next = record;
      let settledAtBoot = false;
      if (verdicts.size > 0 || restore) {
        let retired: readonly RetiredCall[] = [];
        let lost = 0;
        next = await this.write(key, record.agent, (r) => {
          retired = [];
          lost = 0;
          // A turn that started here meanwhile owns the record, its marker
          // and its calls included.
          if (this.active.has(key)) return r;
          const reconciled = retireReconciled(
            r,
            verdicts,
            new Date().toISOString(),
          );
          retired = reconciled.retired;
          lost = retired.filter((x) => x.verdict === "lost").length;
          let out = reconciled.record;
          // A session with no continuation is restored by its next turn,
          // which emits `restored` on the exchange that runs it.
          if (
            out.deferral !== undefined &&
            (out.turn !== undefined || out.background.some(lostHere))
          ) {
            lost += out.background.filter(lostHere).length;
            out = restoreAfterRestart(out, lostHere);
          }
          return out;
        });
        lostBackground += lost;
        for (const { call, verdict } of retired) {
          this.startedHere.delete(call.handle);
          if (verdict !== "lost") {
            this.announceSettled(key, next.agent, call, verdict);
          }
        }
        if (lost > 0 || retired.length > 0 || restore) {
          this.host.logger.info(
            {
              agent: record.agent,
              session: key,
              lostBackground: lost,
              reconciled: retired.length,
            },
            "Agent session restored at boot: its previous process is gone",
          );
        }
        settledAtBoot = retired.some((x) => x.verdict !== "lost");
      }
      if (next.deferral === undefined) continue;
      // Read again after the awaits above: a stop that landed during them
      // must not have a revival started under it.
      if (this.stopping) break;
      if (next.inbox.length > 0) {
        this.revive(
          key,
          next.agent,
          next.deferral,
          settledAtBoot || awaitsSettlementWake(record)
            ? "settlement"
            : "restart",
        );
        revived += 1;
      } else if (next.background.length === 0) {
        await this.releaseDeferral(key, next.agent, next.deferral);
      }
    }
    return { revived, lostBackground };
  }

  /**
   * One page of the sessions the caller's scope admits.
   *
   * Every filter is a record read, so a page costs one read per session
   * the store holds rather than one per session shown, on every page. That
   * is what a store with no owner-aware listing can honestly offer, and it
   * is the price of the paragraph below. An optional filtered listing on
   * the store contract is the way out when the cost starts to matter.
   *
   * The ownership filter runs here rather than inside a store, so a store
   * implementation that answers `keys()` with everything it holds still
   * cannot leak one caller's conversations to another. It runs BEFORE the
   * page is sliced, not after: `takePage` mints the cursor from the last
   * row of the page it returns, and a cursor is reversible by design, so
   * slicing first would hand this caller a foreign session id in an
   * envelope they can decode. A page can come back shorter than the page
   * size when the keys on it belong to somebody else, which is a paging
   * artefact rather than the end of the collection: `nextCursor` is what
   * says whether more remain.
   */
  async summaries(
    query: AgentSessionListQuery,
  ): Promise<OpsPage<AgentSessionSummary>> {
    // The scope is part of the fingerprint so a cursor minted for one
    // caller cannot be replayed as another caller's page.
    const cursorScope: CursorScope = {
      fingerprint: JSON.stringify([
        query.agent ?? null,
        query.cwd ?? null,
        scopeFingerprint(query.scope),
      ]),
    };
    const after =
      query.after === undefined
        ? undefined
        : decodeCursor(query.after, cursorScope);
    const keys = (await this.store.list())
      .map((key) => ({ id: key, key }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // Filtered before the slice, never after. `takePage` mints the cursor
    // from the last row of the page it returns, and a cursor is reversible
    // by design, so slicing the unfiltered list would hand this caller a
    // foreign session id in an envelope they can decode. That is the
    // identifier this scope exists to make indistinguishable from one that
    // does not exist. The cost is a read per session scanned rather than
    // per session shown, which is what a store with no owner-aware listing
    // can honestly offer.
    const admitted: Array<{ id: string; summary: AgentSessionSummary }> = [];
    for (const { id, key } of keys) {
      const summary = await this.summary(key, query.scope);
      if (summary === undefined) continue;
      // The agent is a field now, so filtering by it is a record read
      // like every other filter rather than a prefix on the key.
      if (query.agent !== undefined && summary.agent !== query.agent) continue;
      if (query.cwd !== undefined && summary.cwd !== query.cwd) continue;
      admitted.push({ id, summary });
    }
    const page = takePage(admitted, cursorScope, query.limit, after);
    const items = page.items.map((entry) => entry.summary);
    return page.nextCursor === undefined
      ? { items }
      : { items, nextCursor: page.nextCursor };
  }

  /**
   * The agent a bare session id belongs to, within this scope.
   *
   * One read: the id IS the key, so there is nothing to search. The
   * ownership filter is the same `summary()` every other read goes
   * through, so a foreign id is as unfindable here as it is there.
   */
  async find(
    session: string,
    scope: AgentSessionScope,
  ): Promise<string | undefined> {
    return (await this.summary(session, scope))?.agent;
  }

  /**
   * One session, or `undefined` when the store has never seen it OR when
   * the scope does not own it.
   *
   * The two answer alike deliberately: a caller who could tell a foreign
   * session from an absent one would have an oracle for which ids exist,
   * and guessing is cheap.
   */
  async summary(
    key: AgentSessionKey,
    scope: AgentSessionScope,
  ): Promise<AgentSessionSummary | undefined> {
    const record = await this.store.load(key);
    if (!record) return undefined;
    if (!scopeOwns(scope, record.owner ?? null)) return undefined;
    return {
      agent: record.agent,
      session: record.session,
      owner: record.owner ?? null,
      ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
      ...(record.title !== undefined ? { title: record.title } : {}),
      turn: this.isRunning(key)
        ? "running"
        : record.turn !== undefined
          ? "stale"
          : "idle",
      inbox: record.inbox.length,
      background: record.background.length,
      deferred: record.deferral !== undefined,
      messages: record.messages.length,
      turns: record.turns,
      updatedAt: record.updatedAt,
    };
  }

  /**
   * Write to a session on behalf of a named agent: the one path every
   * dispatch takes to the record.
   *
   * Two things belong here and nowhere else. A session the store has never
   * seen is created naming this agent, which is the only moment a record
   * learns which one it belongs to. And a dispatch naming an agent the
   * record does not is refused rather than served: without this it would
   * run its own executor, with its own system prompt and tools, over a
   * transcript the stored agent wrote, and the record would keep naming
   * the other one. An agent is never turned into another agent.
   *
   * There is no exception. A session belongs to the agent that created it
   * for its whole life, so a mismatch has only this one outcome and no
   * path exists to change the field afterwards.
   *
   * @throws RC5003 when `agent` is not the agent the record names
   */
  private write(
    key: AgentSessionKey,
    agent: string,
    mutate: (record: AgentSessionRecord) => AgentSessionRecord,
  ): Promise<AgentSessionRecord> {
    return this.store.update(key, (record) => {
      if (record === undefined) return mutate(emptyAgentSession(key, agent));
      if (record.agent !== agent) {
        throw rcError("RC5003", undefined, {
          message: `Agent session "${key}" belongs to "${record.agent}" and this dispatch names "${agent}". A conversation is answered by one agent, which carries its own system prompt and tools, so a different agent is a different conversation: dispatch "${agent}" with a session id of its own.`,
        });
      }
      return mutate(record);
    });
  }

  /**
   * Open a session before its first turn, so the record carries who it
   * belongs to and where it is bound from the moment it exists rather than
   * from whenever a turn first runs.
   *
   * Idempotent on an existing session's identity: `owner` and `title` are
   * each written once and never rewritten, so re-opening a conversation
   * cannot transfer it and cannot rename it. A listing that renamed itself
   * on every message would be unreadable, and who a conversation belongs
   * to is not a later speaker's to change. `cwd` is set when supplied,
   * because where a conversation is bound is a property of the connection
   * that is holding it.
   */
  async open(
    key: AgentSessionKey,
    agent: string,
    init: AgentSessionInit,
  ): Promise<AgentSessionRecord> {
    return this.write(key, agent, (record) => ({
      ...record,
      ...(record.owner === undefined ? { owner: init.owner } : {}),
      ...(init.cwd !== undefined ? { cwd: init.cwd } : {}),
      ...(record.title === undefined && init.title !== undefined
        ? { title: init.title }
        : {}),
    }));
  }

  /**
   * Store per-session overrides, applied by the turn that runs next.
   *
   * Every value is checked against what the agent advertises before it is
   * written, here rather than in the caller: the record is the last place
   * a value nobody offered could enter the system, and the turn that
   * applies it does not re-check. An agent this context does not have
   * registered advertises nothing, so it accepts no override at all.
   *
   * @throws AI1017 when a value is outside the agent's advertised list
   */
  async configure(
    key: AgentSessionKey,
    agent: string,
    overrides: AgentSessionOverrides,
  ): Promise<AgentSessionRecord> {
    assertOverridesAdvertised(agent, this.host.agent(agent) ?? {}, overrides);
    return this.write(key, agent, (record) => {
      const next = { ...record.overrides, ...overrides };
      // Undefined keys are dropped rather than stored: the store holds
      // plain JSON and an explicit undefined is not a value.
      const cleaned: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(next)) {
        if (value !== undefined) cleaned[name] = value;
      }
      return {
        ...record,
        overrides: cleaned as AgentSessionOverrides,
      };
    });
  }

  /**
   * Stop the session's running turn, keeping the partial transcript.
   *
   * Interruption otherwise rides on a posted message, which is what a
   * caller sending "stop and answer this instead" wants. A protocol cancel
   * carries no message at all, so it needs the operation on its own.
   *
   * @returns whether a turn was running here to stop
   */
  interrupt(key: AgentSessionKey, agent: string): boolean {
    const running = this.active.get(key);
    if (!running) return false;
    running.controller.abort(INTERRUPT_REASON);
    this.emit(running.exchange, "route:agent:session:interrupted", {
      agentName: agent,
      session: key,
    });
    return true;
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
    const id = randomUUID();
    const controller = new AbortController();
    const consumed = new Set<string>();
    const outcome = this.execute(k, req, incoming, controller, consumed, id);
    // Observed here so a turn nobody awaits (a boundary follow-up that the
    // route tracks) never surfaces as an unhandled rejection; the waiters
    // that do await it still receive the rejection.
    outcome.catch(() => undefined);
    const turn: ActiveTurn = {
      id,
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
    turnId: string,
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
      let retired: readonly RetiredCall[] = [];
      let verdicts: ReadonlyMap<string, ParkVerdict> | undefined;
      const lostHere = (call: AgentBackgroundCall): boolean =>
        this.lostHere(call);
      const unreconciled: { calls: AgentBackgroundCall[] | undefined } = {
        calls: undefined,
      };
      const mutate = (r: AgentSessionRecord): AgentSessionRecord => {
        unreconciled.calls = undefined;
        lostBackground = 0;
        stale = false;
        empty = false;
        retired = [];
        let next = r;
        if (r.turn !== undefined) {
          // A marker this process did not set: the previous process died
          // mid-turn. The transcript it persisted is kept, every tool call
          // it left open is closed as interrupted, each background call
          // whose route never parked is reported lost rather than silently
          // dropped, and each parked one is reconciled against its deferral,
          // which is read outside this synchronous mutation.
          if (verdicts === undefined && r.background.some(isParked)) {
            unreconciled.calls = r.background.filter(isParked);
            return r;
          }
          stale = true;
          const reconciled = retireReconciled(
            r,
            verdicts ?? NO_VERDICTS,
            new Date().toISOString(),
          );
          retired = reconciled.retired;
          lostBackground =
            reconciled.record.background.filter(lostHere).length +
            retired.filter((x) => x.verdict === "lost").length;
          next = restoreAfterRestart(reconciled.record, lostHere);
        }
        // Core has settled the continuation this exchange revives; the
        // record stops naming it, and a fresh one is stored at this turn's
        // end if work is still outstanding.
        if (
          req.revived !== undefined &&
          next.deferral?.deferralId === req.revived
        ) {
          next = withoutDeferral(next);
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
          // Written once, by whoever opened the conversation. A later turn
          // under another principal does not transfer it, because the
          // field gates who may list and read the session.
          ...(next.owner === undefined ? { owner: req.by } : {}),
          messages: [...next.messages, user],
          inbox: [],
          turn: {
            exchangeId: exchange.id,
            startedAt: new Date().toISOString(),
          },
        };
      };
      let started = await this.write(key, req.agent, mutate);
      if (unreconciled.calls !== undefined) {
        verdicts = await this.reconcileParked(key, unreconciled.calls);
        started = await this.write(key, req.agent, mutate);
      }
      for (const { call, verdict } of retired) {
        this.startedHere.delete(call.handle);
        if (verdict !== "lost") {
          this.announceSettled(key, started.agent, call, verdict);
        }
      }
      if (req.revived !== undefined) {
        this.emit(exchange, "route:agent:session:revived", {
          agentName: req.agent,
          session: key,
          deferralId: req.revived,
        });
      }
      if (stale) {
        this.emit(exchange, "route:agent:session:restored", {
          agentName: req.agent,
          session: key,
          lostBackground,
        });
      }
      if (empty) {
        after = await this.deferIfOutstanding(req, started);
        return {
          text: "",
          session: {
            agent: req.agent,
            id: key,
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
            await this.write(key, req.agent, (r) => ({
              ...r,
              messages,
            }));
          },
          started.overrides,
        );
      } catch (err) {
        // Whatever stopped the turn, what it reached is kept: the thread
        // is what the next turn starts from, and the marker must not
        // outlive the turn in this process.
        const partial = executor.thread() ?? startMessages;
        const written = await this.write(key, req.agent, (r) => ({
          ...withoutTurn(r),
          messages: partial,
        }));
        if (!controller.signal.aborted) {
          after = written;
          throw err;
        }
        after = await this.deferIfOutstanding(req, written);
        return {
          text: "",
          session: {
            agent: req.agent,
            id: key,
            status: "interrupted",
            queued: after.inbox.length,
            turn: turnId,
          },
        };
      }
      const final = executor.thread() ?? startMessages;
      after = await this.deferIfOutstanding(
        req,
        await this.write(key, req.agent, (r) => ({
          ...withoutTurn(r),
          messages: final,
          turns: r.turns + 1,
        })),
      );
      return {
        ...result,
        session: {
          agent: req.agent,
          id: key,
          status: "replied",
          queued: after.inbox.length,
          turn: turnId,
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
        boundary.deferral === undefined &&
        (boundary.inbox.length > 0 || boundary.background.length > 0)
      ) {
        this.lastRequests.pin(k);
      }
      if (
        boundary !== undefined &&
        boundary.inbox.length > 0 &&
        !this.stopping
      ) {
        if (boundary.deferral !== undefined) {
          this.active.delete(k);
          this.revive(key, req.agent, boundary.deferral, "boundary", {
            k,
            req,
          });
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
  private async deferIfOutstanding<T>(
    req: AgentTurnRequest<T>,
    record: AgentSessionRecord,
  ): Promise<AgentSessionRecord> {
    const outstanding = record.background.length > 0 || record.inbox.length > 0;
    if (!outstanding) {
      if (record.deferral === undefined) return record;
      await this.releaseDeferral(req.key, req.agent, record.deferral);
      return withoutDeferral(record);
    }
    if (record.deferral !== undefined || req.defer === undefined) return record;
    let deferral: AgentSessionDeferral;
    let announced: AgentSessionDeferral | undefined;
    try {
      // The record names the deferral before the deferral exists, so a crash
      // between the two writes leaves a reference the boot releases.
      deferral = await req.defer(async (pending) => {
        announced = pending;
        await this.write(req.key, req.agent, (r) => ({
          ...r,
          deferring: pending,
        }));
      });
    } catch (err: unknown) {
      // Without a continuation the queued messages run in process and a
      // completion waits for the next message: the shape sessions had
      // before defers, and the log is what says why this one is on it.
      this.host.logger.error(
        { err, agent: req.agent, session: req.key },
        "Agent session continuation could not be stored; completions wait for the next message",
      );
      // A failure after the announce may leave a deferral behind, and the
      // record is about to stop naming it. Settled here rather than left
      // for a boot that will no longer find a reference to it; a release
      // that fails keeps the reference, so that boot still finds it.
      if (announced !== undefined) {
        try {
          await this.store.releaseDeferral(
            announced.deferralId,
            "agent session deferral announced but never named",
          );
        } catch {
          return { ...record, deferring: announced };
        }
      }
      return await this.write(req.key, req.agent, withoutDeferring).catch(() =>
        withoutDeferring(record),
      );
    }
    let updated: AgentSessionRecord;
    try {
      updated = await this.write(req.key, req.agent, (r) => ({
        ...withoutDeferring(r),
        deferral,
      }));
    } catch (err: unknown) {
      // Nothing names the continuation now, so nothing will ever revive
      // it; settled before the store failure reaches the caller.
      await this.store
        .releaseDeferral(
          deferral.deferralId,
          "agent session record write failed",
        )
        .catch(() => undefined);
      throw err;
    }
    this.emit(req.exchange, "route:agent:session:deferred", {
      agentName: req.agent,
      session: req.key,
      deferralId: deferral.deferralId,
      inbox: updated.inbox.length,
      background: updated.background.length,
    });
    return updated;
  }

  /** Settle a continuation nothing will revive and drop it from the record. */
  private async releaseDeferral(
    key: AgentSessionKey,
    agent: string,
    deferral: AgentSessionDeferral,
  ): Promise<void> {
    await this.store.releaseDeferral(deferral.deferralId, "agent session idle");
    await this.write(key, agent, (r) =>
      r.deferral?.deferralId === deferral.deferralId ? withoutDeferral(r) : r,
    );
  }

  /**
   * Revive a session's stored continuation on this process: core resumes
   * the deferred exchange at the agent step, the step runs the next turn
   * from the inbox, and the route's downstream steps follow. At most one
   * revival per session at a time, and none while a turn is running here,
   * because that turn's boundary does this itself.
   *
   * A revival that fails (the route is gone, its continuation changed, the
   * store refused) is logged and the record stops naming the deferral; the
   * queued messages then run in process when a caller is waiting on them,
   * and otherwise wait for the next message.
   *
   * @param wake - What woke the session; a `settlement` re-identifies the
   *   parked principal before the revival ({@link reidentify}).
   */
  private revive<T>(
    key: AgentSessionKey,
    agent: string,
    deferral: AgentSessionDeferral,
    wake: Wake,
    fallback?: { k: string; req: AgentTurnRequest<T> },
  ): void {
    const k = key;
    if (this.stopping || this.reviving.has(k) || this.active.has(k)) return;
    const deferralRuntime = this.host.continuations();
    if (!deferralRuntime) return;
    this.reviving.add(k);
    const run = (async () => {
      const options =
        wake === "settlement"
          ? await this.reidentify(key, agent, deferral, deferralRuntime)
          : {};
      // Refused: the continuation stays stored for whatever wakes the
      // session next, and no turn runs in the parked identity's name.
      if (options === undefined) return;
      const token = deferralRuntime.signer.mint(
        deferral.deferralId,
        new Date(),
      );
      await this.host.resume({ token, result: undefined }, options);
    })()
      .catch(async (err: unknown) => {
        this.host.logger.error(
          {
            err,
            session: key,
            deferralId: deferral.deferralId,
            routeId: deferral.routeId,
          },
          "Agent session continuation could not be revived",
        );
        // Settled as well as dropped: a record the session no longer names
        // would otherwise stay live in the store with nothing to revive it.
        await this.releaseDeferral(key, agent, deferral).catch(() => undefined);
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
   * Decide whose principal a revival on a background settlement runs under.
   *
   * The stored continuation replays a principal read back from a record,
   * which no gate trusts: run restored, every authorized tool call the
   * revived turn made would be refused, so waking the agent would achieve
   * nothing. The application's `reidentify` hook re-verifies the identity
   * from live state instead, and the framework holds it to the SAME
   * identity, scopes included; anything else, including no hook at all,
   * refuses the revival. An exchange that parked without a principal is
   * revived as it always was.
   *
   * The hook is bounded by {@link REIDENTIFY_TIMEOUT_MS} and by the runtime
   * stopping, and is handed the signal that carries both so it can cancel
   * its own I/O; whichever fires first refuses the revival.
   *
   * A refusal is logged and announced on `route:agent:session:revival:refused`
   * with its reason, and leaves the continuation stored: the settlement is
   * in the inbox, and the session sees it when something else wakes it.
   *
   * @returns The revival options, or `undefined` when the revival is refused
   */
  private async reidentify(
    key: AgentSessionKey,
    agent: string,
    deferral: AgentSessionDeferral,
    runtime: DeferralRuntime,
  ): Promise<RevivalOptions | undefined> {
    const stored = await runtime.store.get(deferral.deferralId);
    // A record that is gone is reported by the resume, as it always was.
    if (!stored) return {};
    const authority = this.host.authority();
    const parked = deferredPrincipal(stored, authority);
    if (parked === undefined) return {};
    const refuse = (reason: string, err?: unknown): undefined => {
      this.host.logger.warn(
        {
          agent,
          session: key,
          deferralId: deferral.deferralId,
          routeId: deferral.routeId,
          subject: parked.subject,
          reason,
          ...(err !== undefined ? { err } : {}),
        },
        "Agent session revival refused: the parked principal could not be re-identified",
      );
      this.emitAt(
        deferralScope(stored),
        "route:agent:session:revival:refused",
        {
          agentName: agent,
          session: key,
          deferralId: deferral.deferralId,
          reason,
        },
      );
      return undefined;
    };
    const hook = this.host.reidentify();
    if (hook === undefined) {
      return refuse(
        "no reidentify hook is registered; agentPlugin({ reidentify }) re-verifies the parked identity from live state",
      );
    }
    // Bounded: an unsettled hook would hold the session in `reviving`,
    // refusing every later wake of it, and hold `stop()` with it.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), REIDENTIFY_TIMEOUT_MS);
    const signal = anySignal(this.halt.signal, deadline.signal);
    let live: Principal | undefined;
    try {
      live = await settleOrAbort(() => hook(parked, { signal }), signal);
    } catch (err: unknown) {
      if (err !== HOOK_ABORTED) return refuse("the reidentify hook threw", err);
      return refuse(
        this.halt.signal.aborted
          ? "the reidentify hook had not settled when the runtime stopped"
          : `the reidentify hook did not settle within ${REIDENTIFY_TIMEOUT_MS}ms`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (live === undefined) return refuse("the reidentify hook declined");
    const deviation = reidentificationDeviation(parked, live, authority);
    if (deviation !== undefined) {
      return refuse(`the reidentify hook ${deviation}`);
    }
    return { reidentified: live };
  }

  /**
   * An append that landed on an idle session must not wait for another
   * caller: the stored continuation is revived when there is one, and
   * otherwise the turn is started in process on the last request this
   * process ran for the session, as a boundary without a deferral would.
   *
   * A `settlement` wake is the one that happens on somebody else's
   * decision; see {@link reidentify}.
   */
  private deliverIdle(
    key: AgentSessionKey,
    record: AgentSessionRecord,
    wake: "append" | "settlement",
  ): void {
    // Once shutdown began the append stays in the record for the next
    // process: a turn started now would run on a context being drained.
    if (this.stopping) return;
    const k = key;
    const last = this.lastRequests.get(k);
    if (record.deferral !== undefined) {
      this.revive(
        key,
        record.agent,
        record.deferral,
        wake,
        last ? { k, req: last } : undefined,
      );
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
        this.host.logger.error(
          { err, agent: req.agent, session: req.key },
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
    const identity = identityOf(exchange);
    if (!identity) return;
    this.emitAt(identity, name, details);
  }

  private emitAt<K extends SessionEventName>(
    identity: ExchangeScoped,
    name: K,
    details: SessionEventDetails<K>,
  ): void {
    // The generic cannot be narrowed per arm inside one method; each
    // caller's `details` is checked against its own event above.
    this.host.emit(name, { ...identity, ...details } as EventDetailsMap[K]);
  }
}

/** The identity events about an exchange's turn are scoped to, when it has a route. */
function identityOf(exchange: Exchange<unknown>): ExchangeScoped | undefined {
  return dispatchIdentityFrom(
    exchange,
    getExchangeRoute(exchange)?.definition.id,
  );
}

/**
 * How a background call ended, as the run that settles it reports it. The
 * tool, the caller and the start time are read from the call the record
 * holds, so whatever delivers the outcome needs only the handle.
 *
 * @internal
 */
export type BackgroundOutcome = {
  readonly handle: string;
} & BackgroundRunOutcome;

/** How the run behind a background call ended. @internal */
export type BackgroundRunOutcome =
  | { readonly status: "completed"; readonly result: unknown }
  | {
      readonly status: "failed";
      readonly error: {
        readonly rc?: string;
        readonly message: string;
        readonly name: string;
      };
    };

/**
 * The outcome a completed run delivers for its body.
 *
 * A body that is itself a `Deferred` acknowledgment, on a run that did not
 * park, is a continuation that completed with another route's receipt:
 * that park is not linked to this handle, and its live token must not
 * reach the inbox, so delivery fails with `AI1006` and the park stays
 * pending in the application's own flow. A body that throws while being
 * inspected is retired without forwarding either it or an accessor's
 * possibly sensitive error.
 *
 * @internal
 */
export function outcomeOfResult(body: unknown): BackgroundRunOutcome {
  let deferred: boolean;
  try {
    deferred = isDownstreamDeferred(body);
  } catch {
    return {
      status: "failed",
      error: {
        name: "Error",
        message:
          "The background result could not be stored because it could not be inspected safely.",
      },
    };
  }
  if (deferred) return unlinkedParkOutcome();
  return { status: "completed", result: body };
}

/** The failure a park this handle cannot track is delivered as. */
function unlinkedParkOutcome(): BackgroundRunOutcome {
  return {
    status: "failed",
    error: {
      rc: "AI1006",
      name: "RoutecraftError",
      message:
        "The route answered with another route's deferral acknowledgment, which this background handle cannot track. The action is still awaiting approval, not cancelled or completed. Do not retry it; use the application's approval flow to resolve the pending action.",
    },
  };
}

/**
 * A failed run's error, as the inbox carries it: the same text the tool
 * bridge renders for a foreground tool that threw.
 *
 * @internal
 */
export function errorOf(err: unknown): {
  readonly rc?: string;
  readonly message: string;
  readonly name: string;
} {
  const rc = rcCodeOf(err);
  return {
    ...(rc !== undefined ? { rc } : {}),
    message: errorMessage(err),
    name: errorName(err),
  };
}

/** A background call whose route parked, so a restart reconciles it rather than losing it. */
function isParked(call: AgentBackgroundCall): boolean {
  return call.deferralId !== undefined;
}

/** The handle and session a background dispatch put on its exchange, when it carries both. */
function backgroundCallOf(
  headers: Readonly<Record<string, unknown>>,
): { readonly session: string; readonly handle: string } | undefined {
  const handle = headers[AgentHeadersKeys.BACKGROUND_HANDLE];
  const session = headers[AgentHeadersKeys.BACKGROUND_SESSION];
  return typeof handle === "string" && typeof session === "string"
    ? { session, handle }
    : undefined;
}

/** The failure a park that expired before its decision delivers. */
function expiredOutcome(
  deferralId: string,
  expiresAt: Date,
): BackgroundRunOutcome {
  return {
    status: "failed",
    error: {
      rc: "RC5047",
      name: "RoutecraftError",
      message: `The route parked for a decision that never came: deferral "${deferralId}" expired at ${expiresAt.toISOString()}. Ask again if it is still needed.`,
    },
  };
}

/** The failure a park that was denied delivers: its continuation will never run. */
function deniedOutcome(
  deferralId: string,
  reason: string | undefined,
): BackgroundRunOutcome {
  return {
    status: "failed",
    error: {
      rc: "RC5050",
      name: "RoutecraftError",
      message: `The route parked, and its deferral "${deferralId}" was denied${reason ? `: ${reason}` : ""}. Its continuation will not run; start it again if it is still needed.`,
    },
  };
}

/** The failure a run the route dropped delivers. */
function droppedOutcome(reason: string): BackgroundRunOutcome {
  return {
    status: "failed",
    error: {
      name: "Dropped",
      message: `The route dropped the exchange instead of completing it: ${reason}.`,
    },
  };
}

/**
 * What a reconciliation does with a parked call: settle it with an outcome,
 * or report it lost the way a call that never parked is.
 */
type ParkVerdict = BackgroundRunOutcome | "lost";

const NO_VERDICTS: ReadonlyMap<string, ParkVerdict> = new Map();

/** A call a reconciliation took off the record, and what it was retired with. */
interface RetiredCall {
  readonly call: AgentBackgroundCall;
  readonly verdict: ParkVerdict;
}

/**
 * The verdict a deferral record gives the call parked on it, or `undefined`
 * to keep waiting. See {@link AgentSessionRuntime.reconcileParked}.
 */
function parkVerdict(
  deferralId: string,
  parked: Deferral | undefined,
): ParkVerdict | undefined {
  if (parked === undefined) return "lost";
  const outcome = parked.outcome;
  if (parked.state === "waiting" || outcome === undefined) return undefined;
  if (outcome.kind === "expired") {
    return expiredOutcome(deferralId, parked.expiresAt ?? outcome.at);
  }
  if (outcome.kind === "denied")
    return deniedOutcome(deferralId, outcome.reason);
  const run = parked.continuation;
  // Resumed, and execution two died before recording how it ended.
  if (run === undefined) return "lost";
  switch (run.status) {
    case "completed":
      return outcomeOfResult(run.body);
    case "failed":
      return {
        status: "failed",
        error: {
          ...(run.error?.rc !== undefined ? { rc: run.error.rc } : {}),
          name: run.error?.rc !== undefined ? "RoutecraftError" : "Error",
          message: run.error?.message ?? "the continuation failed",
        },
      };
    case "dropped":
      return droppedOutcome(run.reason ?? "dropped by the route");
    case "deferred":
      return undefined;
  }
}

/**
 * Whether a record the previous process left holds settlements its own
 * wake never got through: only background entries in the inbox and no turn
 * cut short. That wake was a settlement, refused by `reidentify` or lost
 * to the crash before it ran, so the boot revives it as one; reviving it
 * as a restart would run the turn a refusal stopped. A message in the
 * inbox, or a turn cut short, means the entries were waiting on that
 * turn's boundary, which does not re-identify.
 */
function awaitsSettlementWake(record: AgentSessionRecord): boolean {
  return (
    record.turn === undefined &&
    record.inbox.length > 0 &&
    record.inbox.every((entry) => entry.kind === "background")
  );
}

/** The inbox entry that delivers a background call's outcome. */
function settlementEntry(
  call: AgentBackgroundCall,
  outcome: BackgroundRunOutcome,
  at: string,
): AgentInboxMessage {
  // The record is plain JSON, and a route may answer with anything: a
  // result the store cannot hold is delivered as a failure naming the
  // reason rather than refused at the write, which would leave the call
  // in `background` for good.
  const delivered: Pick<
    Extract<AgentInboxMessage, { kind: "background" }>,
    "status" | "result" | "error"
  > = outcome.status === "completed"
    ? encodeResult(outcome.result)
    : {
        status: "failed",
        error: {
          ...(outcome.error.rc !== undefined ? { rc: outcome.error.rc } : {}),
          message: outcome.error.message,
        },
      };
  return {
    kind: "background",
    id: randomUUID(),
    at,
    handle: call.handle,
    tool: call.tool,
    by: call.by,
    ...delivered,
  };
}

/** The inbox entry that reports a background call no process is running any more. */
function lostEntry(call: AgentBackgroundCall, at: string): AgentInboxMessage {
  return {
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
  };
}

/**
 * Retire every call a verdict names, delivering each outcome to the inbox
 * in the same write. A call the record no longer holds was settled live
 * meanwhile, and is not delivered twice.
 */
function retireReconciled(
  record: AgentSessionRecord,
  verdicts: ReadonlyMap<string, ParkVerdict>,
  at: string,
): { record: AgentSessionRecord; retired: readonly RetiredCall[] } {
  if (verdicts.size === 0) return { record, retired: [] };
  const retired: RetiredCall[] = [];
  const kept: AgentBackgroundCall[] = [];
  for (const call of record.background) {
    const verdict = verdicts.get(call.handle);
    if (verdict === undefined) kept.push(call);
    else retired.push({ call, verdict });
  }
  if (retired.length === 0) return { record, retired };
  return {
    record: {
      ...record,
      background: kept,
      inbox: [
        ...record.inbox,
        ...retired.map(({ call, verdict }) =>
          verdict === "lost"
            ? lostEntry(call, at)
            : settlementEntry(call, verdict, at),
        ),
      ],
    },
    retired,
  };
}

type SessionEventName =
  | "route:agent:session:queued"
  | "route:agent:session:interrupted"
  | "route:agent:session:restored"
  | "route:agent:session:deferred"
  | "route:agent:session:revived"
  | "route:agent:session:revival:refused"
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

/** Whether a scope admits a record with this owner. */
function scopeOwns(scope: AgentSessionScope, owner: string | null): boolean {
  return scope === "operator" || scope.owner === owner;
}

/** The part of a scope a page cursor is bound to. */
function scopeFingerprint(scope: AgentSessionScope): string | null {
  return scope === "operator" ? "operator" : `owner:${scope.owner ?? ""}`;
}

function withoutTurn(record: AgentSessionRecord): AgentSessionRecord {
  // Destructured rather than set to undefined: the store drops undefined
  // properties, but the record type does not admit one.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit
  const { turn: _turn, ...rest } = record;
  return rest;
}

function withoutDeferral(record: AgentSessionRecord): AgentSessionRecord {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit
  const { deferral: _deferral, ...rest } = record;
  return rest;
}

function withoutDeferring(record: AgentSessionRecord): AgentSessionRecord {
  if (record.deferring === undefined) return record;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit
  const { deferring: _deferring, ...rest } = record;
  return rest;
}

/**
 * How long a `reidentify` hook may take before the revival it gates is
 * refused. Generous for a directory lookup, and still a bound: the session
 * cannot be woken while the hook runs.
 *
 * @internal
 */
export const REIDENTIFY_TIMEOUT_MS = 30_000;

/**
 * What woke a stored continuation: a message appended to an idle session,
 * a background settlement, the boundary of a turn that ran here, or a boot
 * driving what a previous process left. Only a settlement is somebody
 * else's decision, so only a settlement re-identifies the parked principal.
 */
type Wake = "append" | "settlement" | "boundary" | "restart";

/** What {@link settleOrAbort} rejects with when the signal wins, so an abort is never read as a throw. */
const HOOK_ABORTED: unique symbol = Symbol("routecraft.ai.reidentify.aborted");

/**
 * Run an application hook bounded by a signal: core's race for `elevate`,
 * which it does not export. The listener is removed on every path, and the
 * hook is invoked inside the race so a synchronous throw rejects it.
 *
 * @throws {@link HOOK_ABORTED} when the signal fires first
 */
async function settleOrAbort<T>(
  run: () => T | Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw HOOK_ABORTED;
  let onAbort: (() => void) | undefined;
  const bound = new Promise<never>((_, reject) => {
    onAbort = () => reject(HOOK_ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([bound, (async () => run())()]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
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
    // result the route never produced; refused here as the deferral
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
function restoreAfterRestart(
  record: AgentSessionRecord,
  isLost: (call: AgentBackgroundCall) => boolean,
): AgentSessionRecord {
  const at = new Date().toISOString();
  // A parked call is kept here: the park is durable, and it was reconciled
  // against its deferral before this runs.
  return {
    ...withoutTurn(record),
    messages: closeUnansweredToolCalls(record.messages),
    inbox: [
      ...record.inbox,
      ...record.background.filter(isLost).map((call) => lostEntry(call, at)),
    ],
    background: record.background.filter((call) => !isLost(call)),
  };
}
