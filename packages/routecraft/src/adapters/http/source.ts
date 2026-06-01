import { type CraftContext, type CraftPlugin } from "../../context";
import { rcError } from "../../error";
import type { Source, SourceMeta } from "../../operations/from";
import type { Exchange, ExchangeHeaders } from "../../exchange";
import {
  HTTP_PLUGIN_REGISTERED,
  HTTP_ROUTE_REGISTRY,
  type HttpRouteAuthMode,
  type HttpRouteEntry,
  type HttpRouteRegistry,
} from "../../plugins/http/registry";
import { compilePathMatcher } from "../../plugins/http/path-matcher";
import type { HttpMethod, HttpRequestBody, HttpServerOptions } from "./types";

// Surface CraftPlugin in the public types of this module so consumers that
// only import the source adapter still see the symbol (without re-exporting
// the whole plugin entry point).
export type { CraftPlugin };

/**
 * Source adapter exposed by `http({ path, method })` when used with
 * `.from(...)`. Registers itself in the http plugin's registry on
 * subscribe; deregisters on abort. The plugin owns the listener, the auth
 * middleware, and the dispatcher -- this adapter is just the entry that
 * tells the dispatcher "this route claims this path/method".
 */
export class HttpSourceAdapter implements Source<HttpRequestBody> {
  readonly adapterId = "routecraft.adapter.http.source";

  constructor(private readonly options: HttpServerOptions) {}

  async subscribe(
    context: CraftContext,
    handler: (
      message: HttpRequestBody,
      headers?: ExchangeHeaders,
    ) => Promise<Exchange>,
    abortController: AbortController,
    onReady?: () => void,
    meta?: SourceMeta,
  ): Promise<void> {
    const registered = context.getStore(HTTP_PLUGIN_REGISTERED);
    if (registered !== true) {
      throw rcError("RC5003", undefined, {
        message:
          "http() source requires the http plugin. Add `http: { port, ... }` to defineConfig({...}) so the plugin is wired automatically.",
      });
    }
    const registry: HttpRouteRegistry | undefined =
      context.getStore(HTTP_ROUTE_REGISTRY);
    if (!registry) {
      throw rcError("RC5003", undefined, {
        message:
          "http() source: route registry missing from context store. The http plugin failed to initialise.",
      });
    }

    const method: HttpMethod = this.options.method ?? "GET";
    const matcher = compilePathMatcher(this.options.path);
    const routeId = meta?.routeId ?? `http:${method}:${matcher.pattern}`;
    const authMode: HttpRouteAuthMode = this.options.auth ?? "required";
    const entry: HttpRouteEntry = {
      routeId,
      method,
      matcher,
      authMode,
      discovery: meta?.discovery,
      handler: (body, headers) => handler(body as HttpRequestBody, headers),
    };

    if (registry.has(routeId)) {
      throw rcError("RC5003", undefined, {
        message: `http() source: duplicate route id "${routeId}"`,
      });
    }
    for (const existing of registry.values()) {
      if (
        existing.method === method &&
        existing.matcher.pattern === matcher.pattern
      ) {
        throw rcError("RC5003", undefined, {
          message: `http() source: duplicate route ${method} ${matcher.pattern} (already claimed by "${existing.routeId}")`,
        });
      }
    }
    registry.set(routeId, entry);

    onReady?.();

    // Hold the subscription open until the route is aborted. The dispatcher
    // calls our entry's handler for each incoming request; no per-request
    // work happens here.
    await new Promise<void>((resolve) => {
      if (abortController.signal.aborted) {
        registry.delete(routeId);
        resolve();
        return;
      }
      abortController.signal.addEventListener(
        "abort",
        () => {
          registry.delete(routeId);
          resolve();
        },
        { once: true },
      );
    });
  }
}
