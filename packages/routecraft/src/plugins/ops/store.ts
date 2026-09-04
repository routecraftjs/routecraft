import type { HealthLedger } from "./state";
import type { CraftContext } from "../../context";
import { rcError } from "../../error";
import type { OpsResource } from "./types";

/**
 * Symbol key the ops plugin publishes its per-context ledger under.
 *
 * Exposed on the store so other surfaces can read health without going
 * through HTTP: the CLI's TUI, a future management console, and the `/ops`
 * action endpoints all need the same ledger the endpoints report from.
 * `Symbol.for` so the key is shared across duplicate package copies in a
 * workspace, matching every other plugin's convention.
 */
export const OPS_HEALTH_STATE: unique symbol = Symbol.for(
  "routecraft.plugin.ops.health-state",
);

/**
 * Symbol key for the management resources other packages contribute, keyed
 * by resource name. Written by {@link registerOpsResource}, read by the ops
 * mount per request, so a resource registered by a plugin applied before
 * or after the ops plugin is served alike.
 */
export const OPS_RESOURCES: unique symbol = Symbol.for(
  "routecraft.plugin.ops.resources",
);

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [OPS_HEALTH_STATE]: HealthLedger;
    [OPS_RESOURCES]: Map<string, OpsResource>;
  }
}

/** Names the mount serves itself; a contributed resource cannot take them. */
const RESERVED_RESOURCE_NAMES = new Set(["routes", "events"]);

/** A resource name is one path segment: what an operator types after `/ops/`. */
const RESOURCE_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Contribute a read-only resource to the management API. See
 * {@link OpsResource} for the contract and where it is served.
 *
 * Call it from a plugin's `apply()`. It needs no ops plugin to be present:
 * the registration lives on the context store and is served when an ops
 * mount exists, and inert otherwise.
 *
 * @throws RC5053 on a reserved or malformed name, or a name already taken
 */
export function registerOpsResource(
  ctx: CraftContext,
  resource: OpsResource,
): void {
  if (!RESOURCE_NAME.test(resource.name)) {
    throw rcError("RC5053", undefined, {
      message: `Management resource name "${resource.name}" must be one lowercase path segment (letters, digits and dashes), because it is what follows /ops/ on the wire.`,
    });
  }
  if (RESERVED_RESOURCE_NAMES.has(resource.name)) {
    throw rcError("RC5053", undefined, {
      message: `Management resource name "${resource.name}" is served by the ops mount itself and cannot be contributed.`,
    });
  }
  const registry =
    ctx.getStore(OPS_RESOURCES) ?? new Map<string, OpsResource>();
  if (registry.has(resource.name)) {
    throw rcError("RC5053", undefined, {
      message: `Management resource "${resource.name}" is already registered on this context. One contributor per name.`,
    });
  }
  registry.set(resource.name, resource);
  ctx.setStore(OPS_RESOURCES, registry);
}
