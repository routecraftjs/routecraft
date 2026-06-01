import type { Exchange, ExchangeHeaders } from "../../exchange";
import type { RouteDiscovery } from "../../route";
import type { HttpMethod } from "../../adapters/http/types";
import type { PathMatcher } from "./path-matcher";

/**
 * How the dispatcher applies the plugin's global auth middleware to a route.
 * See {@link HttpServerOptions.auth} for the user-facing description.
 */
export type HttpRouteAuthMode = "required" | "optional" | "skip";

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
  readonly authMode: HttpRouteAuthMode;
  /** Route-level discovery bundle, used by /openapi.json. */
  readonly discovery: RouteDiscovery | undefined;
  /** Provided by the source on subscribe; the dispatcher calls it once it has a parsed body. */
  readonly handler: (
    body: unknown,
    headers: ExchangeHeaders,
  ) => Promise<Exchange>;
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
 * entries on subscribe / abort). `Symbol.for` so the key is shared across
 * any duplicate package copies in a workspace (matches the convention used
 * by every other plugin in `.standards/adapter-architecture.md`).
 */
export const HTTP_ROUTE_REGISTRY: unique symbol = Symbol.for(
  "routecraft.plugin.http.registry",
);

/**
 * Symbol key used by the http source to assert the plugin has been
 * registered. Set to `true` in `httpPlugin.apply(ctx)`. The source throws
 * `RC5003` when it is missing so misconfiguration fails at subscribe time.
 */
export const HTTP_PLUGIN_REGISTERED: unique symbol = Symbol.for(
  "routecraft.plugin.http.registered",
);

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [HTTP_ROUTE_REGISTRY]: HttpRouteRegistry;
    [HTTP_PLUGIN_REGISTERED]: boolean;
  }
}
