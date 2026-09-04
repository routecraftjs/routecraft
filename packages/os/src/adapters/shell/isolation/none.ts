import type { HostTier, Invocation, IsolationRequest } from "./types.ts";
import { refuseContainerOptions } from "./host.ts";

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
export const noneTier: HostTier = {
  name: "none",
  kind: "host",
  ensureAvailable(): Promise<void> {
    return Promise.resolve();
  },
  refuse(request: IsolationRequest): string | undefined {
    // Both refusals exist because this tier contains nothing, so an
    // option asking it to contain something can only be voided. Egress
    // is the one that bites: `network` defaults to denied, so every
    // `isolation: "none"` call was asking for a denial it silently did
    // not get. Saying so costs the author one visible word and buys
    // back the difference between "I accepted egress" and "I assumed I
    // had none".
    if (!request.network) {
      return (
        `the "none" tier cannot deny network egress, and the call left egress denied. ` +
        `A command under this tier reaches the network exactly as the calling process does. ` +
        `Write network: true beside isolation: "none" to accept that out loud, or choose a tier that can deny it.`
      );
    }
    if (request.mapRootUser) {
      return (
        `the "none" tier cannot map identity, and the call asked for root. ` +
        `A command under this tier runs as the calling user. ` +
        `Drop mapRootUser, or choose a tier with a user namespace.`
      );
    }
    return refuseContainerOptions("none", request);
  },
  wrap(target: Invocation): Invocation {
    return target;
  },
};
