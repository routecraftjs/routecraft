import { port } from "../../kernel/port.ts";
import type { Exchange, ExchangeHeaders } from "../../exchange";
import type { RouteDiscovery } from "../../route";
import type { HttpMethod, HttpResponder } from "../../adapters/http/types";
import type { PathMatcher } from "./path-matcher";
import type { HttpWebhookSignatureOptions } from "./webhook-signature";

/**
 * One entry in an http mount's route registry. Created when a
 * `from(http({...}))` source subscribes and removed on abort. The mount's
 * dispatcher matches incoming requests against this registry.
 *
 * The route's `handler` is the runtime-provided callback that turns a message
 * into a fully-processed {@link Exchange}. The source's job is just to call
 * it (and to convert the result back into the wire format).
 */
export interface HttpRouteEntry {
  readonly routeId: string;
  readonly method: HttpMethod;
  /** Matcher over the FULL request path (mount prefix already joined in). */
  readonly matcher: PathMatcher;
  /**
   * The route declares a route-entry `.authorize()`. On a walled mount this
   * is redundant (the wall already ran); on a public mount it forces the
   * dispatcher to pull credential verification for this route.
   */
  readonly requiresPrincipal: boolean;
  /** Whether the route opted in to `routecraft.http.rawBody` on the exchange. */
  readonly rawBody: boolean;
  /** Webhook-signature gate; requests failing verification 401 before the route runs. */
  readonly signature: HttpWebhookSignatureOptions | undefined;
  /**
   * Decides when the caller is answered and with what. Undefined leaves the
   * dispatcher's own path, which awaits the pipeline and serialises it.
   */
  readonly respond: HttpResponder | undefined;
  /** Route-level discovery bundle, used by /openapi.json. */
  readonly discovery: RouteDiscovery | undefined;
  /** Provided by the source on subscribe; the dispatcher calls it once it has a parsed body. */
  readonly handler: (
    body: unknown,
    headers: ExchangeHeaders,
  ) => Promise<Exchange>;
}

/**
 * Per-mount route registry. The http plugin instantiates one per configured
 * mount; source adapters resolve their mount by name and push/pop entries.
 */
export type HttpRouteRegistry = Map<string, HttpRouteEntry>;

/**
 * Read-only view over route entries, satisfied by a single registry Map and
 * by the combined all-mounts view the built-ins (`/ready`, `/openapi.json`)
 * consume so they report every mount's routes.
 */
export interface HttpRouteView {
  readonly size: number;
  values(): IterableIterator<HttpRouteEntry>;
}

/**
 * What the http source needs to know about one configured mount: where its
 * routes register and which path prefix route patterns are joined onto.
 */
export interface HttpMountRuntime {
  /** Mount path prefix; `"/"` for the catch-all. */
  readonly path: string;
  readonly registry: HttpRouteRegistry;
}

/** What the http plugin offers the http source: its configured mounts. */
export interface HttpMounts {
  /** Every configured mount, by name. */
  readonly mounts: ReadonlyMap<string, HttpMountRuntime>;
}

/**
 * The http plugin's mount table. An `http()` source resolves its mount here
 * at subscribe time and registers its route in that mount's registry.
 */
export const HTTP = port<HttpMounts>("routecraft.http@1");
