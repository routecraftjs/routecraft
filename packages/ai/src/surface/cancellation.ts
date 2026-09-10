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
  getExchangeContext,
  type CraftContext,
  type Exchange,
} from "@routecraft/routecraft";
import { ADAPTER_AGENT_SESSIONS } from "../agent/store.ts";
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
  /** The turn running when this was registered, absent outside a turn. */
  readonly turn: string | undefined;
  entries: Cleanup[];
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
    [AGENT_SURFACE_CLEANUPS]: Map<string, Registration>;
    [AGENT_SURFACE_LIFECYCLE]: true;
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

function pins(context: CraftContext): Map<string, AgentSurfaceRef> {
  const pinned =
    context.getStore(AGENT_SURFACE_PINS) ?? new Map<string, AgentSurfaceRef>();
  context.setStore(AGENT_SURFACE_PINS, pinned);
  return pinned;
}

/**
 * The turn running on the conversation right now, or nothing.
 *
 * Read off the store rather than through the runtime's own accessor,
 * because that accessor builds a runtime on demand and refuses a context
 * with no deferral store, and a surface on a bare exchange must do
 * neither.
 */
function runningTurnOf(
  context: CraftContext,
  session: string,
): string | undefined {
  return context.getStore(ADAPTER_AGENT_SESSIONS)?.turnIdOf(session);
}

/**
 * The controller the conversation's current turn rides, minted when the
 * stored one belongs to a turn that has since been replaced.
 *
 * One per conversation, because a conversation runs one turn at a time and
 * an interrupt names the conversation. It survives the turn ending, which
 * is what keeps it aborted while the cancelled turn's routes wind down and
 * makes their calls refusals rather than fresh requests; the next turn to
 * run replaces it.
 *
 * Both the reader and the canceller resolve through here. They must agree
 * on which controller is current, and the failure when they do not is
 * silent: a cancel aborts a controller nobody is handed, and a stopped
 * turn's routes go on reaching the person's editor.
 */
function controllerFor(
  context: CraftContext,
  session: string,
): AbortController {
  const signals = turnSignals(context);
  const running = runningTurnOf(context, session);
  const current = signals.get(session);
  if (
    current !== undefined &&
    (running === undefined || current.turn === running)
  ) {
    return current.controller;
  }
  const controller = new AbortController();
  signals.set(session, { turn: running, controller });
  return controller;
}

/**
 * The signal every request for the conversation's running turn rides.
 *
 * @internal
 */
export function turnSignalOf(
  context: CraftContext,
  session: string,
): AbortSignal {
  return controllerFor(context, session).signal;
}

/**
 * Cancel what the conversation's turn has outstanding, and send the
 * cleanup that turn's routes registered.
 *
 * The cleanup is not awaited: `session/prompt` answers `cancelled` on its
 * own clock, and a slow editor must not hold that answer.
 *
 * @internal
 */
export function cancelSurfaceTurn(
  context: CraftContext,
  session: string,
): void {
  const cancelled = runningTurnOf(context, session);
  controllerFor(context, session).abort();
  void runCleanups(context, session, cancelled);
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
  pins(context).set(exchangeId, ref);
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
  return context.getStore(AGENT_SURFACE_PINS)?.get(exchangeId);
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
      turn: runningTurnOf(context, ref.session),
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
  const session =
    pinned?.get(exchangeId)?.session ??
    context.getStore(AGENT_SURFACE_CLEANUPS)?.get(exchangeId)?.session;
  pinned?.delete(exchangeId);
  context.getStore(AGENT_SURFACE_CLEANUPS)?.delete(exchangeId);
  if (session === undefined) return;
  if (runningTurnOf(context, session) !== undefined) return;
  for (const ref of pinned?.values() ?? []) {
    if (ref.session === session) return;
  }
  for (const entry of context.getStore(AGENT_SURFACE_CLEANUPS)?.values() ??
    []) {
    if (entry.session === session) return;
  }
  context.getStore(AGENT_SURFACE_TURN_SIGNALS)?.delete(session);
}

/**
 * Send the cleanup the cancelled turn's routes registered, in registration
 * order, then forget it. Sequential, because the order a route gave them
 * in is the order they make sense in: a terminal is killed before it is
 * released.
 *
 * This is a boundary: a cleanup that fails is logged and the next one is
 * still sent. Nothing awaits the outcome, so a throw here would reach
 * nobody. A connection that has since gone is skipped at debug, since an
 * editor that left took its terminal with it.
 */
async function runCleanups(
  context: CraftContext,
  session: string,
  cancelled: string | undefined,
): Promise<void> {
  const registered = registrations(context);
  const due: Array<[string, Registration]> = [];
  for (const [exchangeId, entry] of registered) {
    if (entry.session !== session) continue;
    // A route the previous turn dispatched can still be running. Its
    // terminal is not this cancel's to close.
    if (entry.turn !== undefined && entry.turn !== cancelled) continue;
    due.push([exchangeId, entry]);
    registered.delete(exchangeId);
  }
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
