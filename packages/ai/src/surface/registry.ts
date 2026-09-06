/**
 * Where the live surfaces are, for the length of a connection.
 *
 * Keyed on the context rather than on a module-level map, so two contexts
 * in one process (a test suite is the usual case) cannot see each other's
 * connections.
 */

import type { CraftContext } from "@routecraft/routecraft";
import type { AgentSurfaceRef } from "./header.ts";
import type { AgentSurfaceConnection } from "./types.ts";

/**
 * Store key for the surfaces a context currently holds open, by connection
 * id. `Symbol.for` so the key is shared across duplicate copies of this
 * package in a workspace, matching every other store key here.
 *
 * @internal
 */
export const AGENT_SURFACES: unique symbol = Symbol.for(
  "routecraft.agent.surfaces",
);

/**
 * Store key for the surface each running turn belongs to, by the
 * correlation id the mount minted for it.
 *
 * The header is what says "this exchange is surfaced", and it travels with
 * every exchange derived from the turn's own. It does not travel into a
 * route the turn CALLS: a tool dispatches its route on a fresh exchange
 * carrying the correlation id and the principal, which is the whole point
 * of that dispatch being an ordinary one. The correlation id is what makes
 * the two the same turn, so it is what the second lookup is keyed on, and
 * a route reached from a surfaced turn can ask the person a question
 * however many hops away it is.
 *
 * @internal
 */
export const AGENT_SURFACE_TURNS: unique symbol = Symbol.for(
  "routecraft.agent.surface-turns",
);

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [AGENT_SURFACES]: Map<string, AgentSurfaceConnection>;
    [AGENT_SURFACE_TURNS]: Map<string, AgentSurfaceRef>;
  }
}

/**
 * Publish a live surface, and return the call that retires it.
 *
 * A backend registers on connect and retires on disconnect. Nothing else
 * removes an entry: a turn that outlives its connection reads the absence
 * and answers `AI1014`, which is the honest report.
 *
 * @internal
 */
export function registerSurface(
  context: CraftContext,
  connection: string,
  surface: AgentSurfaceConnection,
): () => void {
  const surfaces =
    context.getStore(AGENT_SURFACES) ??
    new Map<string, AgentSurfaceConnection>();
  surfaces.set(connection, surface);
  context.setStore(AGENT_SURFACES, surfaces);
  return () => {
    // Only if it is still ours: a reconnect under the same id would
    // otherwise be retired by the disconnect of the connection it replaced.
    if (surfaces.get(connection) === surface) surfaces.delete(connection);
  };
}

/** The live surface a reference names, or `undefined` once it is gone. @internal */
export function surfaceFor(
  context: CraftContext,
  ref: AgentSurfaceRef,
): AgentSurfaceConnection | undefined {
  return context.getStore(AGENT_SURFACES)?.get(ref.connection);
}

/**
 * Record which surface a turn is running for, and return the call that
 * forgets it when the turn ends.
 *
 * @internal
 */
export function registerTurn(
  context: CraftContext,
  correlationId: string,
  ref: AgentSurfaceRef,
): () => void {
  const turns =
    context.getStore(AGENT_SURFACE_TURNS) ?? new Map<string, AgentSurfaceRef>();
  turns.set(correlationId, ref);
  context.setStore(AGENT_SURFACE_TURNS, turns);
  return () => {
    if (turns.get(correlationId) === ref) turns.delete(correlationId);
  };
}

/** The surface a running turn belongs to, by its correlation id. @internal */
export function turnSurfaceOf(
  context: CraftContext,
  correlationId: string | undefined,
): AgentSurfaceRef | undefined {
  if (correlationId === undefined) return undefined;
  return context.getStore(AGENT_SURFACE_TURNS)?.get(correlationId);
}
