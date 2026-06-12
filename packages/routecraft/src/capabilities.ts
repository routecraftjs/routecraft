import type { CraftContext } from "./context.ts";
import type { RouteDiscovery } from "./route.ts";

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
}

/**
 * Core-owned store key for the capability registry, keyed by RAW endpoint.
 *
 * Ownership is deliberately inverted from "core reads an adapter's
 * registry": adapters that expose discoverable endpoints WRITE into this
 * registry via {@link registerCapability}, and `context.capabilities()`
 * reads it without knowing which adapter populated it. That keeps the
 * core context free of adapter knowledge and lets future discoverable
 * adapters surface in `capabilities()` without core changes.
 *
 * `Symbol.for` so duplicate copies of the package (CLI vs user module)
 * share one registry.
 *
 * @internal The registry shape is internal; read via
 *   `context.capabilities()` and write via {@link registerCapability}.
 */
export const CAPABILITY_REGISTRY = Symbol.for("routecraft.capabilities");

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [CAPABILITY_REGISTRY]: Map<string, Capability>;
  }
}

/**
 * Register (or update) a discoverable capability on the context. Called
 * by adapters when a discoverable endpoint subscribes; the direct source
 * is the built-in writer, and ecosystem adapters exposing their own
 * discoverable endpoints use the same call.
 *
 * Keyed by the RAW endpoint id; any transport-level key encoding stays
 * inside the adapter that needs it.
 */
export function registerCapability(
  context: CraftContext,
  capability: Capability,
): void {
  let registry = context.getStore(CAPABILITY_REGISTRY);
  if (!registry) {
    registry = new Map<string, Capability>();
    context.setStore(CAPABILITY_REGISTRY, registry);
  }
  registry.set(capability.endpoint, { ...capability });
}
