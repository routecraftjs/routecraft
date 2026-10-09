/**
 * The live surfaces of one application, and everything their cancellation
 * lifecycle tracks.
 *
 * Shared between two plugins and every route that calls `surface()`: a
 * backend (the ACP mount) publishes connections and turns into it, and the
 * adapter resolves, pins and registers against it at exchange time. State
 * one plugin writes and another reads is a port, so it is reached through
 * {@link SURFACES} rather than a store key. One state per application, so
 * two applications in one process (a test suite is the usual case) cannot
 * see each other's connections.
 */

import {
  getExchangeContext,
  port,
  type Exchange,
  type PluginLogger,
} from "@routecraft/routecraft";
import type { AgentSurfaceRef } from "./header.ts";
import type { AgentSurfaceConnection, SurfaceRequest } from "./types.ts";

/** One call the framework makes for a route whose turn was cancelled. */
export interface SurfaceCleanup {
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
export interface SurfaceRegistration {
  readonly session: string;
  /** The turn this exchange belongs to, which alone may send it. */
  readonly turn: string;
  entries: SurfaceCleanup[];
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
export interface SurfaceTurnSignal {
  readonly session: string;
  readonly controller: AbortController;
}

/** What an exchange pinned: its surface, and the turn it is running for. */
export interface SurfacePin {
  readonly ref: AgentSurfaceRef;
  readonly turn: string;
}

/**
 * A cancel whose cleanup is waiting for the cancelled turn to finish.
 *
 * Keyed by the turn's own exchange id, which is what the interrupt event
 * carries and what the exchange's terminal event will name.
 */
export interface SurfacePendingCancel {
  readonly session: string;
  /** Claimed at the cancel, so a route's own withdrawal cannot race it. */
  readonly due: ReadonlyArray<readonly [string, SurfaceRegistration]>;
  readonly fallback: ReturnType<typeof setTimeout>;
}

/**
 * What {@link SURFACES} provides.
 *
 * The maps are written only by the surface module: a backend publishes
 * through `registerSurface` and `registerTurn`, and a route through
 * `surface()`, so the invariants the cancellation lifecycle keeps between
 * them hold. Anything else reads.
 */
export interface SurfaceState {
  /** The surfaces currently held open, by connection id. */
  readonly surfaces: Map<string, AgentSurfaceConnection>;
  /**
   * The surface each running turn belongs to, by the correlation id the
   * mount minted for it.
   *
   * The header is what says "this exchange is surfaced", and it travels
   * with every exchange derived from the turn's own. It does not travel
   * into a route the turn CALLS: a tool dispatches its route on a fresh
   * exchange carrying the correlation id and the principal, which is the
   * whole point of that dispatch being an ordinary one. The correlation id
   * is what makes the two the same turn, so it is what the second lookup
   * is keyed on, and a route reached from a surfaced turn can ask the
   * person a question however many hops away it is.
   */
  readonly turns: Map<string, AgentSurfaceRef>;
  /** The signal each turn's requests ride, by turn id. */
  readonly signals: Map<string, SurfaceTurnSignal>;
  /** The surface each running exchange resolved, by exchange id. */
  readonly pins: Map<string, SurfacePin>;
  /** The cleanup each running exchange registered, by exchange id. */
  readonly cleanups: Map<string, SurfaceRegistration>;
  /** Cancels waiting for their turn's own exchange, by that exchange's id. */
  readonly pendingCancels: Map<string, SurfacePendingCancel>;
  /** Recently cancelled turns, oldest first, bounded. */
  readonly cancelledTurns: Set<string>;
  /** Where a cleanup sent after the turn ended reports, since nothing awaits it. */
  readonly logger: Pick<PluginLogger, "debug" | "warn">;
}

/**
 * The application's live surfaces, provided by the surfaces plugin.
 *
 * Absent means no backend is installed, which a reader treats exactly as
 * no surface: `surface()` answers `AI1013` and `hasSurface()` is false.
 */
export const SURFACES = port<SurfaceState>("routecraft.ai.surfaces@1");

/**
 * The application's surfaces, or `undefined` when no backend is installed.
 *
 * @internal
 */
export function surfacesOf(
  exchange: Exchange<unknown>,
): SurfaceState | undefined {
  return getExchangeContext(exchange)?.lookup(SURFACES);
}

/** @internal */
export function createSurfaceState(
  logger: SurfaceState["logger"],
): SurfaceState {
  return {
    surfaces: new Map(),
    turns: new Map(),
    signals: new Map(),
    pins: new Map(),
    cleanups: new Map(),
    pendingCancels: new Map(),
    cancelledTurns: new Set(),
    logger,
  };
}
