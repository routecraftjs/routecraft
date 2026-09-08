import type { HealthLedger } from "./state";
import type { CraftContext } from "../../context";
import { rcError } from "../../error";
import type { Duration } from "../../shared/duration.ts";
import { assertIndicatorName } from "./indicator";
import type { FailureDomain, Health, OpsResource } from "./types";

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
export function registerOpsResource<TItem>(
  ctx: CraftContext,
  resource: OpsResource<TItem>,
): void {
  if (typeof resource.name !== "string" || !RESOURCE_NAME.test(resource.name)) {
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
  registry.set(resource.name, resource as OpsResource);
  ctx.setStore(OPS_RESOURCES, registry);
}

/**
 * An indicator another plugin contributes, without the app listing it.
 *
 * `defineIndicator` is the app's API: a handle declared in source and named
 * in `ops.indicators`. A plugin that watches a dependency the app never
 * wrote a line for (the remotes plugin and the instances it imports from)
 * has no such handle to hand the app, so it contributes the declaration
 * here and reports through the function the contribution returns. The
 * ops plugin binds it to its ledger at start, and before that, or without
 * an ops plugin at all, a report is inert for the same reason a push
 * through an unbound handle is: health instrumentation must not be able
 * to fail the code it instruments.
 */
export interface ContributedIndicator {
  readonly name: string;
  readonly domain?: FailureDomain;
  readonly maxAge?: Duration;
  /** Installed by the ops plugin when it binds the indicator; absent until then. */
  report?: (health: Health) => void;
}

/**
 * Symbol key for the indicators other plugins contribute, keyed by name.
 * Written by {@link contributeOpsIndicator}, bound by the ops plugin's
 * `start()`, so a contribution made from any plugin's `apply()` is served
 * whatever order the plugins were applied in.
 *
 * @internal
 */
export const OPS_CONTRIBUTED_INDICATORS: unique symbol = Symbol.for(
  "routecraft.plugin.ops.contributed-indicators",
);

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [OPS_CONTRIBUTED_INDICATORS]: Map<string, ContributedIndicator>;
  }
}

/**
 * Contribute an indicator to the health report from a plugin's `apply()`.
 *
 * Returns the function to report through. Reports before the ops plugin
 * binds the indicator, or in a context with no ops plugin, are dropped.
 *
 * @throws RC5053 on a malformed name, or a name another contributor took
 */
export function contributeOpsIndicator(
  ctx: CraftContext,
  definition: Omit<ContributedIndicator, "report">,
): (health: Health) => void {
  assertIndicatorName(definition.name, "contributeOpsIndicator");
  const registry =
    ctx.getStore(OPS_CONTRIBUTED_INDICATORS) ??
    new Map<string, ContributedIndicator>();
  if (registry.has(definition.name)) {
    throw rcError("RC5053", undefined, {
      message: `Indicator "${definition.name}" is already contributed on this context. One contributor per name.`,
    });
  }
  const entry: ContributedIndicator = { ...definition };
  registry.set(definition.name, entry);
  ctx.setStore(OPS_CONTRIBUTED_INDICATORS, registry);
  return (health) => entry.report?.(health);
}
