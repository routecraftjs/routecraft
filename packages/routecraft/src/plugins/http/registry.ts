import type { Exchange, ExchangeHeaders } from "../../exchange";
import type { RouteDiscovery } from "../../route";
import type { HttpMethod } from "../../adapters/http/types";
import type { PathMatcher } from "./path-matcher";

/**
 * One entry in the http plugin's route registry. Created when a `from(http({...}))`
 * source subscribes and removed on abort. The dispatcher matches incoming
 * requests against this registry.
 *
 * The route's `handler` is the runtime-provided callback that turns a message
 * into a fully-processed {@link Exchange}. The source's job is just to call
 * it (and to convert the result back into the wire format).
 */
export interface HttpRouteEntry {
  readonly routeId: string;
  readonly method: HttpMethod;
  readonly matcher: PathMatcher;
  readonly isPublic: boolean;
  /** Route-level discovery bundle, used by /openapi.json. */
  readonly discovery: RouteDiscovery | undefined;
  /** Provided by the source on subscribe; the dispatcher calls it once it has a parsed body. */
  readonly handler: (
    body: unknown,
    headers: ExchangeHeaders,
  ) => Promise<Exchange>;
  /** Mutable. The dispatcher reads this for /ready; sources flip it via `markReady`. */
  ready: boolean;
}

/**
 * Module-level type that the http plugin instantiates and stores on the
 * context. Source adapters look up this map via the same store key and
 * push/pop their own entries.
 */
export type HttpRouteRegistry = Map<string, HttpRouteEntry>;

/**
 * Symbol key used to share the registry between the http plugin (which
 * creates and owns it) and the http source (which inserts / removes
 * entries on subscribe / abort).
 */
export const HTTP_ROUTE_REGISTRY = "routecraft.plugin.http.registry" as const;

/**
 * Symbol key used by the http source to assert the plugin has been
 * registered. Set to `true` in `httpPlugin.apply(ctx)`. The source throws
 * `RC5003` when it is missing so misconfiguration fails at subscribe time.
 */
export const HTTP_PLUGIN_REGISTERED =
  "routecraft.plugin.http.registered" as const;

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [HTTP_ROUTE_REGISTRY]: HttpRouteRegistry;
    [HTTP_PLUGIN_REGISTERED]: boolean;
  }
}
