/**
 * Header keys the agent tier writes on exchanges it dispatches.
 *
 * Both ride the dispatched exchange's headers rather than any in-memory
 * map, so they survive a park: a deferral record stores the headers and the
 * revived exchange carries them, which is what lets execution two settle
 * the handle it was dispatched under, on whichever process runs it.
 */
export const AgentHeadersKeys = {
  /**
   * The background handle a dispatched exchange belongs to, so an operator
   * reading the route's exchanges can find the run a handle names, and so
   * a resumed run's terminal event can settle that handle. The route mints
   * its own exchange id, so this is the join key.
   */
  BACKGROUND_HANDLE: "routecraft.agent.background.handle",
  /**
   * The session the handle's result is delivered to. Beside the handle
   * because the handle alone names a run, not a conversation, and a
   * settlement read off an event has nothing else to find the record by.
   */
  BACKGROUND_SESSION: "routecraft.agent.background.session",
} as const;

declare module "@routecraft/routecraft" {
  interface RoutecraftHeaders {
    /** The background tool handle this exchange was dispatched under. */
    "routecraft.agent.background.handle"?: string;
    /** The agent session a background tool's result is delivered to. */
    "routecraft.agent.background.session"?: string;
  }
}
