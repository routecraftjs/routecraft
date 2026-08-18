import type { HealthState } from "./state";

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

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [OPS_HEALTH_STATE]: HealthState;
  }
}
