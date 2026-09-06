/**
 * The contract a surface backend implements, and the method map the first
 * one serves.
 *
 * The backend registers a connection; `surface()` finds it and calls it.
 * Nothing here knows how the connection is transported, which is what lets
 * a second backend arrive without the routes changing.
 */

import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { AgentSurfaceKind } from "./header.ts";

/**
 * The client-side methods a surface may be asked for, keyed by name, with
 * the params and response of each.
 *
 * Taken from the Agent Client Protocol's own generated types rather than
 * restated here: the wire shapes are the SDK's to define, and a hand-copied
 * map would drift the first time the protocol adds a field. `import type`
 * only, so the optional peer is never loaded to satisfy a type.
 */
export type SurfaceRequestParams = ClientRequestParamsByMethod;

/** The response each surface method answers with. See {@link SurfaceRequestParams}. */
export type SurfaceRequestResponses = ClientRequestResponsesByMethod;

/** A method name a route may call on the person's surface. */
export type SurfaceMethod = keyof SurfaceRequestParams & string;

/** One update pushed at a surface rather than asked of it. */
export type SurfaceUpdate = SessionUpdate;

/**
 * A live connection to one person's surface, registered by the backend
 * that holds it open for as long as it is connected.
 *
 * Every method takes the session, because one connection can carry several
 * conversations and an update belongs to exactly one of them.
 */
export interface AgentSurfaceConnection {
  readonly kind: AgentSurfaceKind;
  /**
   * Whether the client advertised the capability this method needs.
   *
   * Asked before the call rather than discovered from its failure: a
   * client that never offered a method may answer anything at all, or
   * nothing, and a route deserves to be told it is a configuration
   * mismatch rather than left waiting.
   */
  supports(method: string): boolean;
  /** The capability name a method needs, for the message when it is missing. */
  capabilityFor(method: string): string;
  /** Ask the surface, and wait for the person's answer. */
  request(
    session: string,
    method: string,
    params: unknown,
    signal: AbortSignal | undefined,
  ): Promise<unknown>;
  /** Tell the surface something. No answer, and no waiting. */
  notify(session: string, update: unknown): Promise<void>;
}
