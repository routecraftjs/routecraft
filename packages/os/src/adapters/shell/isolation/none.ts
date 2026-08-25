import type { Invocation, IsolationTier } from "./types.ts";

/**
 * The opt-out tier: a plain subprocess, no isolation promised and none
 * provided. Available everywhere, because it asks nothing of the host.
 *
 * Choosing it is always explicit. Nothing in the adapter ever selects it
 * as a fallback when a stronger tier turns out to be unavailable, which is
 * the single behaviour the isolation design must be incapable of.
 *
 * Argument hygiene still applies here, and so does the fact that `shell()`
 * spawns directly rather than through a shell. What is absent is
 * containment: the command runs with the caller's identity, the caller's
 * view of the filesystem, and the caller's network.
 */
export const noneTier: IsolationTier = {
  name: "none",
  ensureAvailable(): Promise<void> {
    return Promise.resolve();
  },
  wrap(target: Invocation): Invocation {
    return target;
  },
};
