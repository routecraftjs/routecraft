import type { BuiltinHandler } from "./dispatcher";
import { buildOpenApiDocument } from "./openapi";
import type { HttpRouteRegistry } from "./registry";

export interface BuiltinsOptions {
  registry: HttpRouteRegistry;
  /** Whether the always-on built-ins layer should serve `/health`. */
  serveHealth: boolean;
  /**
   * Mode for the always-on built-ins layer's `/ready` handling.
   *
   * - `"off"`: do not serve here. The path is either disabled entirely
   *   (`enabled: false`) or routed through the auth-aware layer
   *   (`requireAuth: true` with auth configured).
   * - `"full"`: serve `{ status: "ready", routes }`. This is the layer
   *   used when `requireAuth: false`, or when `requireAuth: true` but no
   *   global auth is configured (nothing to authenticate against).
   */
  ready: "off" | "full";
  /** Whether the always-on built-ins layer should serve `/openapi.json`. */
  serveOpenApi: boolean;
}

/**
 * Always-on endpoints registered before user routes. The dispatcher consults
 * built-ins only after the user registry returns no match, so a user route
 * registered at the same path takes precedence.
 *
 * The plugin decides which of these to serve based on its `builtins` config;
 * a path served by the auth-aware layer (e.g. `/ready` with
 * `details: "when-authenticated"`, `/openapi.json` with
 * `access: "authenticated"`) is omitted from this handler so the dispatcher
 * runs the auth middleware first.
 *
 * Returns `null` for any other request so the dispatcher can answer 404.
 */
export function createBuiltins(opts: BuiltinsOptions): BuiltinHandler {
  return function builtinHandler(req: Request, pathname: string) {
    const isKnown =
      (pathname === "/health" && opts.serveHealth) ||
      (pathname === "/ready" && opts.ready !== "off") ||
      (pathname === "/openapi.json" && opts.serveOpenApi);
    if (!isKnown) return null;

    if (req.method !== "GET") {
      return new Response(null, { status: 405, headers: { Allow: "GET" } });
    }

    if (pathname === "/health") {
      return jsonResponse({ status: "ok" }, 200);
    }

    if (pathname === "/ready") {
      return jsonResponse({ status: "ready", routes: opts.registry.size }, 200);
    }

    // pathname === "/openapi.json" && opts.serveOpenApi (covered by isKnown above)
    const doc = buildOpenApiDocument(opts.registry);
    return jsonResponse(doc, 200);
  };
}

/**
 * The dispatcher invokes this handler after the auth middleware admits the
 * request. Used by the plugin when `openapi.access === "authenticated"` and
 * an `auth` strategy is configured.
 */
export function createOpenApiGatedHandler(
  registry: HttpRouteRegistry,
): BuiltinHandler {
  return function openApiHandler(req, pathname) {
    if (pathname !== "/openapi.json") return null;
    if (req.method !== "GET") {
      return new Response(null, { status: 405, headers: { Allow: "GET" } });
    }
    return jsonResponse(buildOpenApiDocument(registry), 200);
  };
}

/**
 * Build the `/ready` response when the path is served by the dispatcher's
 * auth-aware layer (`details: "when-authenticated"`). Always returns 200 so
 * k8s readiness probes keep working without a credential; the body varies
 * with the auth result. Spring Boot Actuator calls this same pattern
 * `show-details: when-authorized`.
 */
export function buildReadyResponse(
  registry: HttpRouteRegistry,
  isAuthenticated: boolean,
): Response {
  return isAuthenticated
    ? jsonResponse({ status: "ready", routes: registry.size }, 200)
    : jsonResponse({ status: "ready" }, 200);
}

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
