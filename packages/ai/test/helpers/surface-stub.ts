/**
 * A surface a test drives directly, standing in for a connected editor, and
 * the header that points an exchange at it.
 *
 * The cases that need a real editor go through the ACP harness; these are
 * for the adapter's own boundary, where what matters is what the route
 * hands the surface and what the surface hands back.
 */

import {
  AGENT_SURFACE_HEADER,
  type AgentSurfaceConnection,
} from "../../src/surface/index.ts";

/** The connection name `SURFACED` points at, for `registerSurface`. */
export const SURFACE_CONNECTION = "conn-1";

/** The header naming a surface registered under `SURFACE_CONNECTION`. */
export const SURFACED = {
  [AGENT_SURFACE_HEADER]: {
    kind: "acp",
    session: "s",
    connection: SURFACE_CONNECTION,
  },
};

export interface ScriptedSurface {
  /** Whether the editor advertised the method; every method, by default. */
  readonly supports?: (method: string) => boolean;
  /** What the editor answers a request with. */
  readonly request: (method: string, params: unknown) => Promise<unknown>;
  /** What the editor does with an update; nothing, by default. */
  readonly notify?: (update: unknown) => Promise<void>;
}

/** A surface that answers from `parts`, as an editor on a socket would. */
export function scriptedSurface(
  parts: ScriptedSurface,
): AgentSurfaceConnection {
  return {
    kind: "acp",
    supports: parts.supports ?? (() => true),
    capabilityFor: (method) => method,
    request: (_session, method, params) => parts.request(method, params),
    notify: (_session, update) =>
      parts.notify === undefined ? Promise.resolve() : parts.notify(update),
  };
}
