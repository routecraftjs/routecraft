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
 * Three pieces, all keyed by the conversation, because that is what a
 * cancel names:
 *
 * - A per-conversation signal that aborts on interrupt and is replaced, so
 *   every request in flight for the turn is cancelled at the editor and
 *   nothing new is sent after it. Cancellation reaches the route as a
 *   refusal of the call it was waiting on.
 * - The surface an exchange resolved, pinned by exchange id for the
 *   exchange's life. The mount forgets a turn's surface when the turn ends,
 *   which is before the routes it called have finished, and a route that
 *   had a surface must not be told it never did.
 * - Cleanup a route registered before the cancel, sent by the framework
 *   after it, in order, each under its own short deadline. Only what was
 *   registered runs: a route gets no fresh surface after the person said
 *   stop, which is the whole reason this is a registration rather than a
 *   grace period.
 *
 * Registrations die with their exchange. A route that discharged its own
 * cleanup drops the registration itself; one that finished without saying
 * so has it dropped when the exchange completes, so a cancel later in the
 * conversation cannot replay a release the route already did.
 */

import {
  getExchangeContext,
  type CraftContext,
  type Exchange,
} from "@routecraft/routecraft";
import { ADAPTER_AGENT_SESSIONS } from "../agent/store.ts";
import type { AgentSurfaceRef } from "./header.ts";
import { surfaceFor } from "./registry.ts";
import type { AgentSurfaceConnection, SurfaceRequest } from "./types.ts";

/**
 * How long one cleanup request may take before it is abandoned.
 *
 * Bounded so a stuck editor cannot hold the instance's attention on a
 * turn that is already over; generous enough that a real kill and release
 * complete. Nothing else waits on these.
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

interface Cleanup {
  readonly ref: AgentSurfaceRef;
  readonly connection: AgentSurfaceConnection;
  readonly request: SurfaceRequest;
}

/** The signal for one conversation, and the turn it was minted during. */
interface TurnSignal {
  readonly turn: string | undefined;
  readonly controller: AbortController;
}

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [AGENT_SURFACE_TURN_SIGNALS]: Map<string, TurnSignal>;
    [AGENT_SURFACE_PINS]: Map<string, AgentSurfaceRef>;
    [AGENT_SURFACE_CLEANUPS]: Map<string, Map<string, Cleanup[]>>;
    [AGENT_SURFACE_LIFECYCLE]: true;
  }
}

function turnSignals(context: CraftContext): Map<string, TurnSignal> {
  const existing = context.getStore(AGENT_SURFACE_TURN_SIGNALS);
  if (existing !== undefined) return existing;
  const fresh = new Map<string, TurnSignal>();
  context.setStore(AGENT_SURFACE_TURN_SIGNALS, fresh);
  return fresh;
}

/**
 * The turn running on the conversation right now, or nothing. Read off
 * the store rather than through the runtime's own accessor, because that
 * accessor builds a runtime on demand and refuses a context with no
 * deferral store, and a surface on a bare exchange must not do either.
 */
function runningTurnOf(
  context: CraftContext,
  session: string,
): string | undefined {
  return context.getStore(ADAPTER_AGENT_SESSIONS)?.turnIdOf(session);
}

function cleanups(context: CraftContext): Map<string, Map<string, Cleanup[]>> {
  const existing = context.getStore(AGENT_SURFACE_CLEANUPS);
  if (existing !== undefined) return existing;
  const fresh = new Map<string, Map<string, Cleanup[]>>();
  context.setStore(AGENT_SURFACE_CLEANUPS, fresh);
  return fresh;
}

/**
 * The signal every request for the conversation's running turn rides.
 *
 * Keyed by conversation, minted for the turn running when it is first
 * asked for, and replaced once a later turn is running. So it stays
 * aborted after a cancel for as long as the cancelled turn's routes are
 * still winding down, which is what makes their calls refusals rather
 * than fresh requests, and the next turn on the conversation, however it
 * starts, gets a clean one.
 *
 * @internal
 */
export function turnSignalOf(
  context: CraftContext,
  session: string,
): AbortSignal {
  const signals = turnSignals(context);
  const running = runningTurnOf(context, session);
  const current = signals.get(session);
  if (
    current !== undefined &&
    (running === undefined || current.turn === running)
  ) {
    return current.controller.signal;
  }
  const controller = new AbortController();
  signals.set(session, { turn: running, controller });
  return controller.signal;
}

/**
 * Cancel what the conversation's turn has outstanding, and send the
 * cleanup its routes registered.
 *
 * The signal is minted here when no route has asked for one yet, so a
 * call made after the cancel meets an aborted signal rather than a fresh
 * one. The cleanup is not awaited: `session/prompt` answers `cancelled`
 * on its own clock, and a slow editor must not hold that answer.
 *
 * @internal
 */
export function cancelSurfaceTurn(
  context: CraftContext,
  session: string,
): void {
  const signals = turnSignals(context);
  const running = runningTurnOf(context, session);
  const current = signals.get(session);
  const controller =
    current !== undefined && (running === undefined || current.turn === running)
      ? current.controller
      : new AbortController();
  signals.set(session, { turn: running, controller });
  controller.abort();
  void runCleanups(context, session);
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
): void {
  const pins =
    context.getStore(AGENT_SURFACE_PINS) ?? new Map<string, AgentSurfaceRef>();
  pins.set(exchangeId, ref);
  context.setStore(AGENT_SURFACE_PINS, pins);
}

/** The surface an exchange resolved earlier, if it is still running. @internal */
export function pinnedSurfaceOf(
  context: CraftContext,
  exchangeId: string,
): AgentSurfaceRef | undefined {
  return context.getStore(AGENT_SURFACE_PINS)?.get(exchangeId);
}

/**
 * Register calls to make for a route if its turn is cancelled while the
 * route is still running. Returns the call that withdraws them.
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
  const bySession = cleanups(context);
  let byExchange = bySession.get(ref.session);
  if (byExchange === undefined) {
    byExchange = new Map();
    bySession.set(ref.session, byExchange);
  }
  const registered: Cleanup[] = requests.map((request) => ({
    ref,
    connection,
    request,
  }));
  const own = byExchange.get(exchange.id) ?? [];
  byExchange.set(exchange.id, [...own, ...registered]);
  return () => {
    const current = byExchange.get(exchange.id);
    if (current === undefined) return;
    const kept = current.filter((entry) => !registered.includes(entry));
    if (kept.length === 0) byExchange.delete(exchange.id);
    else byExchange.set(exchange.id, kept);
  };
}

/** Forget what an exchange pinned and registered, once it is over. */
function releaseExchange(context: CraftContext, exchangeId: string): void {
  context.getStore(AGENT_SURFACE_PINS)?.delete(exchangeId);
  const bySession = context.getStore(AGENT_SURFACE_CLEANUPS);
  if (bySession === undefined) return;
  for (const [session, byExchange] of bySession) {
    if (!byExchange.delete(exchangeId)) continue;
    if (byExchange.size === 0) bySession.delete(session);
  }
}

/**
 * Send every cleanup registered on the conversation, in registration
 * order, then forget them. Sequential, because the order a route gave
 * them in is the order they make sense in: a terminal is killed before it
 * is released.
 *
 * This is a boundary: a cleanup that fails is logged and the next one is
 * still sent. Nothing awaits the outcome, so a throw here would reach
 * nobody. A connection that has since gone is skipped at debug, since an
 * editor that left took its terminal with it.
 */
async function runCleanups(
  context: CraftContext,
  session: string,
): Promise<void> {
  const bySession = cleanups(context);
  const byExchange = bySession.get(session);
  if (byExchange === undefined) return;
  bySession.delete(session);
  for (const [exchangeId, cleanups] of byExchange) {
    for (const { ref, connection, request } of cleanups) {
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
        await connection.request(
          ref.session,
          request.method,
          { ...(request.params as object), sessionId: ref.session },
          AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
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
 * Subscribe the lifecycle once per context: an interrupt cancels the
 * conversation's turn, and an exchange ending releases what it held.
 *
 * Installed by the first backend to register a surface, which is the
 * moment a turn can have one. The subscriptions live as long as the
 * context does.
 *
 * @internal
 */
export function ensureSurfaceLifecycle(context: CraftContext): void {
  if (context.getStore(AGENT_SURFACE_LIFECYCLE) === true) return;
  context.setStore(AGENT_SURFACE_LIFECYCLE, true);
  context.on("route:agent:session:interrupted", ({ details }) => {
    cancelSurfaceTurn(context, details.session);
  });
  for (const ended of [
    "route:exchange:completed",
    "route:exchange:failed",
    "route:exchange:dropped",
  ] as const) {
    context.on(ended, ({ details }) => {
      releaseExchange(context, details.exchangeId);
    });
  }
}
