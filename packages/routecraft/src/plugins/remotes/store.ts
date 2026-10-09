import { port } from "../../kernel/port.ts";
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

/** What the remotes plugin offers: the routes it imported. */
export interface Remotes {
  /** Every imported route that currently holds its endpoint, by local endpoint. */
  routes(): ReadonlyMap<string, RemoteRoute>;
}

/**
 * The routes imported from other instances. The remotes plugin also hands
 * the same view to the ops plugin through `OPS`, so the local listing
 * describes and dispatches an imported route like any other.
 */
export const REMOTES = port<Remotes>("routecraft.remotes@1");
