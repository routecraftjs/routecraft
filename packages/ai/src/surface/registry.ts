/**
 * Where the live surfaces are, for the length of a connection.
 *
 * Held in the application's {@link SurfaceState} rather than a module-level
 * map, so two applications in one process cannot see each other's
 * connections.
 */

import type { AgentSurfaceRef } from "./header.ts";
import type { SurfaceState } from "./state.ts";
import type { AgentSurfaceConnection } from "./types.ts";

/**
 * Publish a live surface, and return the call that retires it.
 *
 * A backend registers on connect and retires on disconnect. Nothing else
 * removes an entry: a turn that outlives its connection reads the absence
 * and answers `AI1014`, which is the honest report.
 *
 * The cancellation lifecycle is not installed here: the plugin that
 * provides the state installs it when it binds, so a backend holding the
 * state cannot have one without the other.
 *
 * @internal
 */
export function registerSurface(
  state: SurfaceState,
  connection: string,
  surface: AgentSurfaceConnection,
): () => void {
  const { surfaces } = state;
  surfaces.set(connection, surface);
  return () => {
    // Only if it is still ours: a reconnect under the same id would
    // otherwise be retired by the disconnect of the connection it replaced.
    if (surfaces.get(connection) === surface) surfaces.delete(connection);
  };
}

/** The live surface a reference names, or `undefined` once it is gone. @internal */
export function surfaceFor(
  state: SurfaceState,
  ref: AgentSurfaceRef,
): AgentSurfaceConnection | undefined {
  return state.surfaces.get(ref.connection);
}

/**
 * Record which surface a turn is running for, and return the call that
 * forgets it when the turn ends.
 *
 * @internal
 */
export function registerTurn(
  state: SurfaceState,
  correlationId: string,
  ref: AgentSurfaceRef,
): () => void {
  const { turns } = state;
  turns.set(correlationId, ref);
  return () => {
    if (turns.get(correlationId) === ref) turns.delete(correlationId);
  };
}

/** The surface a running turn belongs to, by its correlation id. @internal */
export function turnSurfaceOf(
  state: SurfaceState,
  correlationId: string | undefined,
): AgentSurfaceRef | undefined {
  if (correlationId === undefined) return undefined;
  return state.turns.get(correlationId);
}
