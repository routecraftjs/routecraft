import { port } from "../../kernel/port.ts";
import { rcError } from "../../error.ts";
import type { Capability } from "../../capabilities.ts";
import type { Exchange } from "../../exchange.ts";
import type {
  DirectBaseOptions,
  DirectChannel,
  DirectChannelType,
} from "./types.ts";

/**
 * Every direct endpoint of one application: the channels routes subscribe
 * on, the capabilities those endpoints advertise, and the endpoints that
 * declared themselves internal instead.
 *
 * Provided by the default-installed `routecraft.direct` plugin and reached
 * through {@link DIRECT}: the direct adapter, `CraftClient`,
 * `context.capabilities()` and the remotes plugin all read and write the
 * one registry, so a remote route installed here is indistinguishable from
 * a local one to every caller.
 */
export interface DirectRegistry {
  /** The application-wide channel type from `CraftConfig.direct`, when set. */
  readonly channelType: DirectChannelType<DirectChannel> | undefined;
  /** Channels by sanitised endpoint (see `sanitizeEndpoint`). */
  readonly channels: Map<string, DirectChannel<Exchange>>;
  /** The capability advertised on a raw endpoint, if any. */
  capability(endpoint: string): Capability | undefined;
  /** Every advertised capability, as registered. */
  capabilities(): IterableIterator<Capability>;
  /**
   * Advertise a capability on its raw endpoint.
   *
   * @returns A disposer that removes THIS registration while it still holds
   *   the endpoint, and nothing once another registration replaced it
   * @throws RC5003 when the endpoint declared itself internal
   */
  registerCapability(capability: Capability): () => void;
  /**
   * Mark a raw endpoint internal: composable in-process, never advertised.
   *
   * @returns A disposer with the same ownership rule as
   *   {@link DirectRegistry.registerCapability}'s
   * @throws RC5003 when the endpoint is already an advertised capability
   */
  registerInternal(endpoint: string): () => void;
  /** Whether a raw endpoint declared itself internal. */
  isInternal(endpoint: string): boolean;
}

/** The direct endpoint registry of an application. */
export const DIRECT = port<DirectRegistry>("routecraft.direct@1");

/**
 * Copy a capability, cloning the mutable `tags` array so neither the
 * registering adapter nor a `capabilities()` caller can mutate the
 * registry's copy (or vice versa) through a shared reference. Schemas
 * (`input` / `output`) are intentionally shared: they are live Standard
 * Schema objects, not data.
 *
 * @internal
 */
export function snapshotCapability(capability: Capability): Capability {
  return {
    ...capability,
    ...(capability.tags ? { tags: [...capability.tags] } : {}),
  };
}

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

  return {
    channelType: options.channelType,
    channels,
    capability: (endpoint) => capabilities.get(endpoint),
    capabilities: () => capabilities.values(),
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
