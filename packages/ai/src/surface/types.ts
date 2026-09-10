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
 * the params a route supplies for each.
 *
 * Taken from the Agent Client Protocol's own generated types rather than
 * restated here: the wire shapes are the SDK's to define, and a hand-copied
 * map would drift the first time the protocol adds a field. `import type`
 * only, so the optional peer is never loaded to satisfy a type.
 *
 * Without `sessionId`, which the protocol declares on every method and the
 * adapter fills in from the running turn. A route may never address
 * another person's editor, so the turn's session is the only one it can
 * mean, and a field the route must not choose is not asked of it.
 */
export type SurfaceRequestParams = {
  [M in keyof ClientRequestParamsByMethod]: WithoutSession<
    ClientRequestParamsByMethod[M]
  >;
};

/**
 * `sessionId` removed from each arm of a union, not from their
 * intersection.
 *
 * `Omit` is not distributive: over a union it keeps only the keys every
 * arm shares, so a method whose params are a union (`elicitation/create`
 * is `form | url`) would lose every arm-specific field and no callback
 * for it could typecheck without a cast. The conditional distributes.
 */
type WithoutSession<T> = T extends unknown
  ? Omit<T, "sessionId"> & {
      /** Never supplied: the running turn's session is filled in. */
      readonly sessionId?: never;
    }
  : never;

/** The response each surface method answers with. See {@link SurfaceRequestParams}. */
export type SurfaceRequestResponses = ClientRequestResponsesByMethod;

/** A method name a route may call on the person's surface. */
export type SurfaceMethod = keyof SurfaceRequestParams & string;

/**
 * One call a route asks the framework to make for it, with the params the
 * method takes. The shape {@link surface.onCancel} registers.
 */
export type SurfaceRequest = {
  [M in SurfaceMethod]: {
    readonly method: M;
    readonly params: SurfaceRequestParams[M];
  };
}[SurfaceMethod];

/** One update pushed at a surface rather than asked of it. */
export type SurfaceUpdate = SessionUpdate;

/**
 * What a backend's `request` rejects with when the connection went away
 * while the call was outstanding.
 *
 * The adapter reports that as the surface disconnecting (`AI1014`) rather
 * than as the person refusing (`AI1016`), because the two have different
 * fixes and only the backend can tell them apart: it knows whether the
 * peer answered or the transport died. A backend that rejects with
 * anything else is read as a refusal.
 */
export class SurfaceDisconnected extends Error {
  constructor(cause: unknown) {
    super("The surface disconnected while the call was outstanding.", {
      cause,
    });
    this.name = "SurfaceDisconnected";
  }
}

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
