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

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [AGENT_SURFACES]: Map<string, AgentSurfaceConnection>;
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
