import { rcError } from "../../error.ts";
import { snapshotCapability, type Capability } from "../../capabilities.ts";
import type { Exchange } from "../../exchange.ts";
import type { DirectBaseOptions } from "./types.ts";
import {
  DIRECT,
  type DirectChannel,
  type DirectChannelType,
  type DirectRegistry,
} from "../../kernel/direct.ts";
import { InMemoryDirectChannel } from "./shared.ts";

export { DIRECT, type DirectRegistry };

/**
 * Build an empty registry.
 *
 * @param options - The `CraftConfig.direct` defaults
 * @internal Built by the `routecraft.direct` plugin.
 */
export function createDirectRegistry(
  options: Pick<DirectBaseOptions, "channelType"> = {},
): DirectRegistry {
  const channels = new Map<string, DirectChannel<Exchange>>();
  const capabilities = new Map<string, Capability>();
  // A token per registration rather than a set of names, so a stale
  // disposer from a route that already stopped finds a stranger and leaves
  // the live marker alone.
  const internal = new Map<string, symbol>();

  const channel = (
    key: string,
    channelType?: DirectChannelType<DirectChannel>,
  ): DirectChannel<Exchange> => {
    let held = channels.get(key);
    if (!held) {
      const Ctor = channelType ?? options.channelType;
      held = Ctor
        ? (new Ctor(key) as DirectChannel<Exchange>)
        : new InMemoryDirectChannel<Exchange>();
      channels.set(key, held);
    }
    return held;
  };

  return {
    channelType: options.channelType,
    existing: (key) => channels.get(key),
    install(key, installed) {
      channels.set(key, installed);
    },
    uninstall(key, installed, restore) {
      if (channels.get(key) !== installed) return;
      if (restore) channels.set(key, restore);
      else channels.delete(key);
    },
    channel,
    send(endpoint, exchange) {
      const key = encodeURIComponent(endpoint);
      // Resolved, never created: a channel nothing subscribes on would sit in
      // the registry for good and hide the endpoint from every later caller's
      // "does anyone listen" check.
      const held = channels.get(key);
      if (!held) {
        return Promise.reject(
          rcError("RC5004", undefined, {
            message: `No direct channel for endpoint "${endpoint}". Is the context started and does a route subscribe to this endpoint?`,
          }),
        );
      }
      return held.send(key, exchange);
    },
    capability: (endpoint) => {
      const held = capabilities.get(endpoint);
      return held && snapshotCapability(held);
    },
    *capabilities() {
      for (const held of capabilities.values()) yield snapshotCapability(held);
    },
    registerCapability(capability) {
      // Loud, not last-writer-wins: a capability is an external door, and an
      // endpoint that declared itself internal must not have one quietly
      // opened beside it.
      if (internal.has(capability.endpoint)) {
        throw rcError("RC5003", undefined, {
          message: `Endpoint "${capability.endpoint}" is declared internal (direct({ internal: true })) and cannot also register as a discoverable capability. Declare the endpoint internal or dispatchable, not both.`,
        });
      }
      const entry = snapshotCapability(capability);
      capabilities.set(capability.endpoint, entry);
      return () => {
        if (capabilities.get(capability.endpoint) === entry) {
          capabilities.delete(capability.endpoint);
        }
      };
    },
    registerInternal(endpoint) {
      // Whichever half of a contradictory declaration registers second is
      // the one that fails, so the contradiction is loud in any source order.
      if (capabilities.has(endpoint)) {
        throw rcError("RC5003", undefined, {
          message: `Endpoint "${endpoint}" is already registered as a discoverable capability and cannot also declare direct({ internal: true }). Declare the endpoint internal or dispatchable, not both.`,
        });
      }
      const token = Symbol(endpoint);
      internal.set(endpoint, token);
      return () => {
        if (internal.get(endpoint) === token) internal.delete(endpoint);
      };
    },
    isInternal: (endpoint) => internal.has(endpoint),
  };
}
