import type { OpsRouteDetail } from "../ops/types";

/**
 * One imported route, as the ops listing presents it.
 *
 * The capability registry carries what the agent surface needs (a schema
 * per arm, a description, tags); this record carries the rest of what the
 * remote said about the route, so the local listing can describe an
 * imported route exactly as the remote's own listing would, with the
 * JSON Schema renderings passed through rather than re-rendered.
 */
export interface RemoteRoute {
  /** The remote's name in `defineConfig({ remotes })`. */
  remote: string;
  /** The route id on the remote. */
  id: string;
  /** The local endpoint the route answers on (`id` for the default remote, else `remote:id`). */
  endpoint: string;
  /** The remote's own description of the route. */
  detail: OpsRouteDetail;
}

/**
 * Symbol key the remotes plugin publishes imported routes under, keyed by
 * local endpoint. Read by the ops management API so an imported route is
 * listed, described and dispatched through the local door like any other.
 *
 * `Symbol.for` so the key is shared across duplicate package copies in a
 * workspace, matching every other plugin's convention.
 *
 * @internal
 */
export const REMOTE_ROUTES: unique symbol = Symbol.for(
  "routecraft.plugin.remotes.routes",
);

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [REMOTE_ROUTES]: Map<string, RemoteRoute>;
  }
}
