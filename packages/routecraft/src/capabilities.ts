import type { CraftContext } from "./context.ts";
import { rcError } from "./error.ts";
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
  // Loud, not last-writer-wins: a capability is an external door, and an
  // endpoint that declared itself internal must not have one quietly opened
  // beside it. Fail-open here would expose the very subroutine the flag
  // exists to close off (e.g. a route carrying both `direct()` and
  // `direct({ internal: true })` sources).
  if (isInternalEndpoint(context, capability.endpoint)) {
    throw rcError("RC5003", undefined, {
      message: `Endpoint "${capability.endpoint}" is declared internal (direct({ internal: true })) and cannot also register as a discoverable capability. Declare the endpoint internal or dispatchable, not both.`,
    });
  }
  let registry = context.getStore(CAPABILITY_REGISTRY);
  if (!registry) {
    registry = new Map<string, Capability>();
    context.setStore(CAPABILITY_REGISTRY, registry);
  }
  registry.set(capability.endpoint, snapshotCapability(capability));
}

/**
 * Core-owned store key for endpoints declared internal, keyed by RAW
 * endpoint. Same ownership inversion as {@link CAPABILITY_REGISTRY}:
 * adapters write, consumers read without knowing which adapter wrote.
 *
 * A `direct({ internal: true })` source registers here INSTEAD of the
 * capability registry: its in-process endpoint works unchanged, while the
 * two external doors (ops dispatch, agent `directTool` resolution) find
 * no capability. This set is what lets their refusals say "declared
 * internal" instead of the wrong advice "add `.from(direct())`" for a
 * route that has one.
 *
 * @internal The set shape is internal; write via
 *   {@link registerInternalEndpoint} and read via {@link isInternalEndpoint}.
 */
export const INTERNAL_ENDPOINT_REGISTRY = Symbol.for(
  "routecraft.capabilities.internal",
);

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [INTERNAL_ENDPOINT_REGISTRY]: Set<string>;
  }
}

/**
 * Record that an endpoint declared itself internal: composable in-process,
 * deliberately absent from the capability registry. Called by adapters at
 * subscribe, alongside where they would otherwise register a capability.
 */
export function registerInternalEndpoint(
  context: CraftContext,
  endpoint: string,
): void {
  // The mirror of the guard in registerCapability: whichever half of a
  // contradictory declaration registers second is the one that fails, so
  // the contradiction is loud regardless of source order.
  if (context.getStore(CAPABILITY_REGISTRY)?.has(endpoint)) {
    throw rcError("RC5003", undefined, {
      message: `Endpoint "${endpoint}" is already registered as a discoverable capability and cannot also declare direct({ internal: true }). Declare the endpoint internal or dispatchable, not both.`,
    });
  }
  let registry = context.getStore(INTERNAL_ENDPOINT_REGISTRY);
  if (!registry) {
    registry = new Set<string>();
    context.setStore(INTERNAL_ENDPOINT_REGISTRY, registry);
  }
  registry.add(endpoint);
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
  return context.getStore(INTERNAL_ENDPOINT_REGISTRY)?.has(endpoint) ?? false;
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
