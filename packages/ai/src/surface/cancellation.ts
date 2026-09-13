/**
 * What a cancelled turn does to the routes still running for it.
 *
 * A route the turn called keeps running after the person presses stop: the
 * agent unwinds at once, and the dispatched route finishes under its own
 * lifecycle, because a half-done route abandoned mid-step is worse than one
 * that completes. That leaves two things for the surface to settle. The
 * request the route has outstanding at the editor is the person's to
 * cancel, since it was made on their behalf, so it is cancelled with the
 * turn. And the cleanup the route owes, a terminal it created and must
 * release, has to reach the editor after the turn is over, or the person is
 * left with something running that nothing will ever close.
 *
 * Three pieces:
 *
 * - A signal per conversation that aborts on interrupt, so every request in
 *   flight for the turn is cancelled at the editor and nothing new is sent
 *   after it. Cancellation reaches the route as a refusal of the call it
 *   was waiting on.
 * - The surface an exchange resolved, pinned for the exchange's life. The
 *   mount forgets a turn's surface when the turn ends, which is before the
 *   routes it called have finished, and a route that had a surface must not
 *   be told it never did.
 * - Cleanup a route registered before the cancel, sent by the framework
 *   after it, in order, each under its own short deadline. Only what was
 *   registered runs: a route gets no fresh surface after the person said
 *   stop, which is the whole reason this is a registration rather than a
 *   grace period.
 *
 * A registration records the turn it was made under, and a cancel sends
 * only its own turn's. A route dispatched by one turn can still be running
 * when the next turn is cancelled, and killing its terminal then would take
 * away work the person never stopped.
 *
 * Registrations die with their exchange. A route that discharged its own
 * cleanup drops the registration itself; one that finished without saying
 * so has it dropped when the exchange completes, so a cancel later in the
 * conversation cannot replay a release the route already did.
 *
 * **Cancellation only.** A graceful stop is not a cancel: the drain lets
 * in-flight exchanges finish and a route releases what it holds through its
 * own `finally`, which still reaches the editor because the surface is only
 * refused after a cancel. What a forced shutdown abandons, it abandons here
 * too, on the same terms core already states: an exchange cut at the
 * deadline emits no terminal event and its registered cleanup is not sent.
 */

import {
  HeadersKeys,
  getExchangeContext,
  type CraftContext,
  type Exchange,
} from "@routecraft/routecraft";
import type { AgentSurfaceRef } from "./header.ts";
import { surfaceFor } from "./registry.ts";
import {
  withSession,
  type AgentSurfaceConnection,
  type SurfaceRequest,
} from "./types.ts";

/**
 * How long one cleanup request may take before it is abandoned.
 *
 * Bounded so a stuck editor cannot hold the instance's attention on a turn
 * that is already over; generous enough that a real kill and release
 * complete. Nothing else waits on these.
 *
 * @internal
 */
export const CLEANUP_TIMEOUT_MS = 5_000;

/** @internal */
export const AGENT_SURFACE_TURN_SIGNALS: unique symbol = Symbol.for(
  "routecraft.agent.surface-turn-signals",
);

/** @internal */
export const AGENT_SURFACE_PINS: unique symbol = Symbol.for(
  "routecraft.agent.surface-pins",
);

/** @internal */
export const AGENT_SURFACE_CLEANUPS: unique symbol = Symbol.for(
  "routecraft.agent.surface-cleanups",
);

/** @internal */
export const AGENT_SURFACE_LIFECYCLE: unique symbol = Symbol.for(
  "routecraft.agent.surface-lifecycle",
);

/** @internal */
export const AGENT_SURFACE_PENDING_CANCELS: unique symbol = Symbol.for(
  "routecraft.agent.surface-pending-cancels",
);

/** @internal */
export const AGENT_SURFACE_CANCELLED_TURNS: unique symbol = Symbol.for(
  "routecraft.agent.surface-cancelled-turns",
);

/**
 * How many cancelled turns are remembered after their signal is evicted.
 *
 * A turn's signal goes once nothing surfaced still holds it, but a route
 * the turn dispatched may not have reached the surface even once, so it
 * holds nothing and is invisible to that eviction. Minting a fresh signal
 * for it would hand a stopped turn a live one. The turn is therefore
 * remembered by id, and a signal minted for a remembered turn is born
 * aborted.
 *
 * A bound rather than a lifetime, because the framework cannot enumerate
 * the routes a turn dispatched: the oldest is forgotten past this many,
 * which is far more cancelled turns than can plausibly have work still
 * winding down.
 *
 * @internal
 */
export const CANCELLED_TURNS_REMEMBERED = 1024;

/**
 * How long a cancelled turn's own exchange may take to settle before the
 * cleanup is sent anyway.
 *
 * The cleanup waits for that exchange so the editor learns the turn is over
 * before it is asked to close what the turn left open. The wait is bounded
 * because a turn whose exchange never reports a terminal event, a forced
 * shutdown among them, must not strand a terminal in somebody's editor
 * forever.
 *
 * @internal
 */
export const SETTLE_TIMEOUT_MS = 10_000;

/** One call the framework makes for a route whose turn was cancelled. */
interface Cleanup {
  readonly ref: AgentSurfaceRef;
  readonly connection: AgentSurfaceConnection;
  readonly request: SurfaceRequest;
}

/**
 * What one exchange registered, and the turn it registered under.
 *
 * Keyed by exchange rather than by conversation, so the frequent operation
 * (an exchange ending, which holds only its own id) is a single delete, and
 * the rare one (a cancel) is a scan bounded by the live surfaced exchanges.
 */
interface Registration {
  readonly session: string;
  /** The turn this exchange belongs to, which alone may send it. */
  readonly turn: string;
  entries: Cleanup[];
}

/**
 * The signal one turn's requests ride, and the conversation it belongs to.
 *
 * Keyed by the turn rather than by the conversation. A route the turn
 * dispatched outlives the turn, and a later turn on the same conversation
 * must not hand that route a fresh un-aborted signal: it was cancelled, and
 * it stays cancelled for as long as it runs. The conversation is kept only
 * so eviction can name it in a log.
 */
interface TurnSignal {
  readonly session: string;
  readonly controller: AbortController;
}

/** What an exchange pinned: its surface, and the turn it is running for. */
interface SurfacePin {
  readonly ref: AgentSurfaceRef;
  readonly turn: string;
}

/**
 * A cancel whose cleanup is waiting for the cancelled turn to finish.
 *
 * Keyed by the turn's own exchange id, which is what the interrupt event
 * carries and what the exchange's terminal event will name.
 */
interface PendingCancel {
  readonly session: string;
  /** Claimed at the cancel, so a route's own withdrawal cannot race it. */
  readonly due: ReadonlyArray<readonly [string, Registration]>;
  readonly fallback: ReturnType<typeof setTimeout>;
}

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [AGENT_SURFACE_TURN_SIGNALS]: Map<string, TurnSignal>;
    [AGENT_SURFACE_PINS]: Map<string, SurfacePin>;
    [AGENT_SURFACE_CLEANUPS]: Map<string, Registration>;
    [AGENT_SURFACE_LIFECYCLE]: true;
    [AGENT_SURFACE_PENDING_CANCELS]: Map<string, PendingCancel>;
    [AGENT_SURFACE_CANCELLED_TURNS]: Set<string>;
  }
}

function turnSignals(context: CraftContext): Map<string, TurnSignal> {
  const signals =
    context.getStore(AGENT_SURFACE_TURN_SIGNALS) ??
    new Map<string, TurnSignal>();
  context.setStore(AGENT_SURFACE_TURN_SIGNALS, signals);
  return signals;
}

function registrations(context: CraftContext): Map<string, Registration> {
  const registered =
    context.getStore(AGENT_SURFACE_CLEANUPS) ?? new Map<string, Registration>();
  context.setStore(AGENT_SURFACE_CLEANUPS, registered);
  return registered;
}

/**
 * Which turn an exchange belongs to.
 *
 * The correlation id, which every exchange a turn dispatched carries, so a
 * route three hops from the prompt names the same turn the prompt did and
 * rides the same signal. An exchange carrying none is its own turn, named
 * for the conversation, which is what a bare exchange reaching a surface
 * directly wants.
 *
 * @internal
 */
export function turnIdOf(exchange: Exchange<unknown>, session: string): string {
  const correlation = exchange.headers[HeadersKeys.CORRELATION_ID];
  return typeof correlation === "string" ? correlation : `session:${session}`;
}

function cancelledTurns(context: CraftContext): Set<string> {
  const cancelled =
    context.getStore(AGENT_SURFACE_CANCELLED_TURNS) ?? new Set<string>();
  context.setStore(AGENT_SURFACE_CANCELLED_TURNS, cancelled);
  return cancelled;
}

function pendingCancels(context: CraftContext): Map<string, PendingCancel> {
  const pending =
    context.getStore(AGENT_SURFACE_PENDING_CANCELS) ??
    new Map<string, PendingCancel>();
  context.setStore(AGENT_SURFACE_PENDING_CANCELS, pending);
  return pending;
}

function pins(context: CraftContext): Map<string, SurfacePin> {
  const pinned =
    context.getStore(AGENT_SURFACE_PINS) ?? new Map<string, SurfacePin>();
  context.setStore(AGENT_SURFACE_PINS, pinned);
  return pinned;
}

/**
 * The controller one turn's requests ride, minted on first use.
 *
 * Both the reader and the canceller resolve through here on the same key,
 * and the failure when they do not agree is silent: a cancel aborts a
 * controller nobody is handed, and a stopped turn's routes go on reaching
 * the person's editor. The key is the turn, so there is nothing to agree
 * about beyond which turn an exchange belongs to, which its correlation id
 * already settles.
 */
function controllerFor(
  context: CraftContext,
  session: string,
  turn: string,
): AbortController {
  const signals = turnSignals(context);
  const current = signals.get(turn);
  if (current !== undefined) return current.controller;
  const controller = new AbortController();
  // Born aborted when the turn was cancelled and its signal has since been
  // evicted. A route the turn dispatched that had not yet reached the
  // surface holds nothing for the eviction to see, and would otherwise be
  // handed a live signal for a turn the person stopped.
  if (cancelledTurns(context).has(turn)) controller.abort();
  signals.set(turn, { session, controller });
  return controller;
}

/**
 * The signal every request this turn makes rides.
 *
 * @param turn - The turn's id, which is the correlation id every exchange
 *   it dispatched carries, so a route three hops from the prompt rides the
 *   same signal as the prompt did.
 * @internal
 */
export function turnSignalOf(
  context: CraftContext,
  session: string,
  turn: string,
): AbortSignal {
  return controllerFor(context, session, turn).signal;
}

/**
 * Cancel what the conversation's turn has outstanding, and arrange the
 * cleanup that turn's routes registered.
 *
 * The signal aborts here, so nothing new reaches the editor from this
 * moment. The cleanup does not go out here: it waits for the cancelled
 * turn's own exchange to settle, so the editor is told the turn ended
 * before it is asked to close what the turn left open. An interrupt is
 * raised while that turn is still unwinding, and dispatching from it put
 * a `terminal/kill` on the wire ahead of the `cancelled` the prompt had
 * yet to answer.
 *
 * Nothing awaits the cleanup either way: `session/prompt` answers on its
 * own clock, and a slow editor must not hold that answer.
 *
 * @param turnExchangeId - The cancelled turn's own exchange, whose terminal
 *   event releases the cleanup. Absent, the cleanup goes at once, which is
 *   what a caller with no turn to wait for wants.
 * @internal
 */
export function cancelSurfaceTurn(
  context: CraftContext,
  session: string,
  turn: string,
  turnExchangeId?: string,
): void {
  remember(context, turn);
  controllerFor(context, session, turn).abort();
  // Claimed here rather than when it is sent. A route that discharges its
  // own cleanup withdraws the registration on its way out, and after a
  // cancel that withdrawal would otherwise race the send and win, leaving
  // the terminal the route could no longer release to nobody.
  const due = claimCleanups(context, session, turn);
  if (due.length === 0) return;
  if (turnExchangeId === undefined) {
    void sendCleanups(context, session, due);
    return;
  }
  const pending = pendingCancels(context);
  const already = pending.get(turnExchangeId);
  if (already !== undefined) clearTimeout(already.fallback);
  const fallback = setTimeout(() => {
    if (pending.delete(turnExchangeId))
      void sendCleanups(context, session, due);
  }, SETTLE_TIMEOUT_MS);
  // Nothing here should keep a process alive: the cleanup is owed to an
  // editor that is still connected, and one that is not has nothing to
  // close.
  fallback.unref?.();
  pending.set(turnExchangeId, { session, due, fallback });
}

/**
 * Record that a turn was cancelled, dropping the oldest past the bound.
 *
 * Insertion order is a Set's own, so the oldest is its first key.
 */
function remember(context: CraftContext, turn: string): void {
  const cancelled = cancelledTurns(context);
  cancelled.delete(turn);
  cancelled.add(turn);
  while (cancelled.size > CANCELLED_TURNS_REMEMBERED) {
    const oldest = cancelled.values().next();
    if (oldest.done === true) break;
    cancelled.delete(oldest.value);
  }
}

/**
 * Release the cleanup a cancel parked on this exchange, if it is the
 * cancelled turn's own exchange settling.
 */
function releaseCancel(context: CraftContext, exchangeId: string): void {
  const pending = context.getStore(AGENT_SURFACE_PENDING_CANCELS);
  const waiting = pending?.get(exchangeId);
  if (waiting === undefined) return;
  pending?.delete(exchangeId);
  clearTimeout(waiting.fallback);
  void sendCleanups(context, waiting.session, waiting.due);
}

/**
 * Remember which surface an exchange resolved, for as long as it runs.
 *
 * @internal
 */
export function pinSurface(
  context: CraftContext,
  exchangeId: string,
  ref: AgentSurfaceRef,
  turn: string,
): void {
  const pinned = pins(context);
  // Set once: the turn an exchange belongs to is decided by its first
  // resolution and must not drift under it, which is the whole point of a
  // pin.
  if (!pinned.has(exchangeId)) pinned.set(exchangeId, { ref, turn });
}

/**
 * The surface an exchange resolved earlier, if it is still running.
 *
 * @internal
 */
export function pinnedSurfaceOf(
  context: CraftContext,
  exchangeId: string,
): AgentSurfaceRef | undefined {
  return context.getStore(AGENT_SURFACE_PINS)?.get(exchangeId)?.ref;
}

/** The turn an exchange pinned when it first resolved a surface. @internal */
export function pinnedTurnOf(
  context: CraftContext,
  exchangeId: string,
): string | undefined {
  return context.getStore(AGENT_SURFACE_PINS)?.get(exchangeId)?.turn;
}

/**
 * Register calls to make for a route if the turn it is running under is
 * cancelled while the route is still going. Returns the call that
 * withdraws them.
 *
 * @internal
 */
export function registerCleanup(
  exchange: Exchange<unknown>,
  ref: AgentSurfaceRef,
  connection: AgentSurfaceConnection,
  requests: readonly SurfaceRequest[],
): () => void {
  const context = getExchangeContext(exchange);
  if (context === undefined) return () => undefined;
  const registered = registrations(context);
  const added: Cleanup[] = requests.map((request) => ({
    ref,
    connection,
    request,
  }));
  const own = registered.get(exchange.id);
  if (own === undefined) {
    registered.set(exchange.id, {
      session: ref.session,
      // The turn this exchange pinned, not whichever is running now: a
      // route that outlives its turn registers under the turn that
      // dispatched it, so only that turn's cancel sends it.
      turn:
        pinnedTurnOf(context, exchange.id) ?? turnIdOf(exchange, ref.session),
      entries: [...added],
    });
  } else {
    own.entries = [...own.entries, ...added];
  }
  return () => {
    const current = registered.get(exchange.id);
    if (current === undefined) return;
    current.entries = current.entries.filter((entry) => !added.includes(entry));
    if (current.entries.length === 0) registered.delete(exchange.id);
  };
}

/**
 * Forget what an exchange pinned and registered, once it is over, and drop
 * the conversation's signal when nothing surfaced is left on it.
 *
 * The signal is the one store with no natural owner: a conversation is not
 * an object with a lifetime here. Evicting it once the conversation holds
 * no pin and no registration and is running no turn keeps the map bounded
 * by live work rather than by every conversation the instance ever served.
 */
function releaseExchange(context: CraftContext, exchangeId: string): void {
  const pinned = context.getStore(AGENT_SURFACE_PINS);
  const registered = context.getStore(AGENT_SURFACE_CLEANUPS);
  const turn =
    pinned?.get(exchangeId)?.turn ?? registered?.get(exchangeId)?.turn;
  pinned?.delete(exchangeId);
  registered?.delete(exchangeId);
  if (turn === undefined) return;
  // A turn's signal outlives the turn on purpose: it is what keeps the
  // routes it dispatched refused while they wind down. It goes when the
  // last of them has.
  for (const pin of pinned?.values() ?? []) {
    if (pin.turn === turn) return;
  }
  for (const entry of registered?.values() ?? []) {
    if (entry.turn === turn) return;
  }
  context.getStore(AGENT_SURFACE_TURN_SIGNALS)?.delete(turn);
}

/**
 * Take the registrations this cancel owns out of the map, so nothing else
 * can claim or withdraw them, and hand them back for sending.
 *
 * Sequential when sent, because the order a route gave them in is the order
 * they make sense in: a terminal is killed before it is released.
 */
function claimCleanups(
  context: CraftContext,
  session: string,
  cancelled: string,
): Array<[string, Registration]> {
  const registered = registrations(context);
  const due: Array<[string, Registration]> = [];
  for (const [exchangeId, entry] of registered) {
    if (entry.session !== session) continue;
    // A route another turn dispatched can still be running. Its terminal is
    // not this cancel's to close, and a registration made under no turn at
    // all belongs to no cancel.
    if (entry.turn !== cancelled) continue;
    due.push([exchangeId, entry]);
    registered.delete(exchangeId);
  }
  return due;
}

/**
 * Send what a cancel claimed, in registration order, and forget it.
 *
 * This is a boundary: a cleanup that fails is logged and the next one is
 * still sent. Nothing awaits the outcome, so a throw here would reach
 * nobody. A connection that has since gone is skipped at debug, since an
 * editor that left took its terminal with it.
 */
async function sendCleanups(
  context: CraftContext,
  session: string,
  due: ReadonlyArray<readonly [string, Registration]>,
): Promise<void> {
  for (const [exchangeId, entry] of due) {
    for (const { ref, connection, request } of entry.entries) {
      const detail = {
        session,
        exchangeId,
        method: request.method,
        source: "surface",
      };
      if (surfaceFor(context, ref) !== connection) {
        context.logger.debug(
          detail,
          "Cleanup registered for a cancelled turn was skipped: the editor has gone",
        );
        continue;
      }
      try {
        await withDeadline(
          connection.request(
            ref.session,
            request.method,
            withSession(request.params, ref),
            AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
          ),
          request.method,
        );
      } catch (err: unknown) {
        context.logger.warn(
          { ...detail, err },
          "Cleanup registered for a cancelled turn failed",
        );
      }
    }
  }
}

/**
 * Give up on a cleanup the editor has not answered.
 *
 * The signal handed to the backend is a request to cancel, not a deadline:
 * the ACP backend forwards it as `$/cancel_request` and still waits for
 * whatever the client eventually answers. Without a local deadline an
 * editor that is connected but wedged holds the sequential loop forever,
 * and the release that was meant to follow a kill is never sent, which is
 * the outcome this module exists to prevent.
 */
function withDeadline<T>(work: Promise<T>, method: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `The editor did not answer "${method}" within ${CLEANUP_TIMEOUT_MS}ms.`,
            ),
          ),
        CLEANUP_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Subscribe the lifecycle once per context: an interrupt cancels the
 * conversation's turn, and an exchange ending releases what it held.
 *
 * Called by `registerSurface`, so a backend cannot publish a surface
 * without it. Installed there rather than left to each backend because the
 * failure of forgetting it is silent: ordinary calls keep working, and
 * only cancellation, cleanup and eviction quietly never happen.
 *
 * @internal
 */
export function ensureSurfaceLifecycle(context: CraftContext): void {
  if (context.getStore(AGENT_SURFACE_LIFECYCLE) === true) return;
  context.setStore(AGENT_SURFACE_LIFECYCLE, true);
  context.on("route:agent:session:interrupted", ({ details }) => {
    cancelSurfaceTurn(
      context,
      details.session,
      details.correlationId,
      details.exchangeId,
    );
  });
  for (const ended of [
    "route:exchange:completed",
    "route:exchange:failed",
    "route:exchange:dropped",
  ] as const) {
    context.on(ended, ({ details }) => {
      // The cleanup first: a cancelled turn's own exchange settling is what
      // releases it, and it must claim its registrations before the same
      // exchange ending drops anything.
      releaseCancel(context, details.exchangeId);
      releaseExchange(context, details.exchangeId);
    });
  }
}
