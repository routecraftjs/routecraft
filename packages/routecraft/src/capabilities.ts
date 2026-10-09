import type { CraftContext } from "./context.ts";
import type { RouteDiscovery } from "./route.ts";
import { DIRECT } from "./kernel/direct.ts";

/**
 * A discoverable capability registered in a context: an endpoint plus the
 * route's discovery bundle (`.title()` / `.description()` / `.input()` /
 * `.output()` / `.tag()`).
 *
 * Returned by {@link CraftContext.capabilities}; dispatch into a
 * capability with `CraftClient.sendDirect(endpoint, body)`.
 */
export interface Capability extends RouteDiscovery {
  /** Raw endpoint / route id, exactly as passed to `.id(...)` / `direct(...)`. */
  endpoint: string;
  /**
   * The remote this capability was imported from (`defineConfig({ remotes })`),
   * absent for a capability a local route registered. Read by the ops
   * listing to name the origin and by the agent tool policy so a rule can
   * keep an agent local-only.
   */
  remote?: string;
}

/**
 * Register (or update) a discoverable capability on the context. Called
 * by adapters when a discoverable endpoint subscribes; the direct source
 * is the built-in writer, and ecosystem adapters exposing their own
 * discoverable endpoints use the same call.
 *
 * The registry is the `DIRECT` port's, so the adapters that write it and
 * `context.capabilities()` that reads it share one view without either
 * knowing which adapter populated it. Keyed by the RAW endpoint id; any
 * transport-level key encoding stays inside the adapter that needs it.
 *
 * @returns A disposer that removes THIS registration when the endpoint is
 *   still held by it, and does nothing once something else has taken the
 *   name. An unconditional delete would be wrong on the one path that
 *   matters: a local route stopping hands its endpoint to the remote route
 *   it shadowed, `route:stopped` reaches the remotes plugin before the
 *   direct source's own abort listener, and a blind delete would then
 *   erase the replacement that already owns the name.
 * @throws RC5003 when the endpoint declared itself internal
 * @throws RC1104 when the context has not installed its plugins
 */
export function registerCapability(
  context: CraftContext,
  capability: Capability,
): () => void {
  return context.require(DIRECT).registerCapability(capability);
}

/**
 * Record that an endpoint declared itself internal: composable in-process,
 * deliberately absent from the capability registry. Called by adapters at
 * subscribe, alongside where they would otherwise register a capability.
 *
 * A `direct({ internal: true })` source registers here INSTEAD of the
 * capability registry: its in-process endpoint works unchanged, while the
 * two external doors (ops dispatch, agent `directTool` resolution) find no
 * capability, and their refusals can say "declared internal" instead of the
 * wrong advice "add `.from(direct())`" for a route that has one.
 *
 * @returns A disposer with the same ownership rule as
 *   {@link registerCapability}'s: it clears the marker only while this
 *   registration still holds it.
 * @throws RC5003 when the endpoint is already a discoverable capability
 * @throws RC1104 when the context has not installed its plugins
 */
export function registerInternalEndpoint(
  context: CraftContext,
  endpoint: string,
): () => void {
  return context.require(DIRECT).registerInternal(endpoint);
}

/**
 * Whether an endpoint declared itself internal. Read by the external doors
 * (ops dispatch, agent tool resolution) to refuse by name rather than with
 * advice that does not apply.
 */
export function isInternalEndpoint(
  context: CraftContext,
  endpoint: string,
): boolean {
  return context.lookup(DIRECT)?.isInternal(endpoint) ?? false;
}

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
