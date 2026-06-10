import { type CraftPlugin } from "../../context";
import { rcError } from "../../error";
import type { Source, Subscription } from "../../operations/from";
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

  constructor(private readonly options: HttpServerOptions) {
    // Fail fast on an unrecognised auth mode. TypeScript catches this for
    // typed callers, but an untyped JS caller (or a typo squeezed through
    // `as any`) would otherwise silently downgrade the route at request
    // time: the dispatcher treats anything that isn't exactly "required" or
    // "skip" as "optional", which means "admit anonymously when no
    // credential is presented." Surface the misconfiguration at the
    // `http({...})` call site, not at the first unauthenticated request.
    const auth = options.auth;
    if (
      auth !== undefined &&
      auth !== "required" &&
      auth !== "optional" &&
      auth !== "skip"
    ) {
      throw rcError("RC5003", undefined, {
        message: `http() source: invalid auth mode ${JSON.stringify(
          auth,
        )}. Allowed: "required", "optional", "skip".`,
      });
    }
  }

  async subscribe(sub: Subscription<HttpRequestBody>): Promise<void> {
    const { context, meta } = sub;
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
    // `auth` was validated in the constructor; here we just normalise the
    // default so the registry entry always carries a concrete mode.
    const authMode: HttpRouteAuthMode = this.options.auth ?? "required";
    const entry: HttpRouteEntry = {
      routeId,
      method,
      matcher,
      authMode,
      discovery: meta?.discovery,
      handler: (body, headers) =>
        sub.emit({
          message: body as HttpRequestBody,
          ...(headers ? { headers } : {}),
        }),
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

    sub.ready();

    // Hold the subscription open until the route is aborted. The dispatcher
    // calls our entry's handler for each incoming request; no per-request
    // work happens here.
    await new Promise<void>((resolve) => {
      if (sub.signal.aborted) {
        registry.delete(routeId);
        resolve();
        return;
      }
      sub.signal.addEventListener(
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
