import type { BuiltinHandler } from "./dispatcher";
import { buildOpenApiDocument } from "./openapi";
import type { HttpRouteRegistry } from "./registry";

export interface BuiltinsOptions {
  registry: HttpRouteRegistry;
  /** Whether the public built-ins layer should serve `/openapi.json`. */
  serveOpenApi: boolean;
}

/**
 * Always-on endpoints registered before user routes. The dispatcher consults
 * built-ins only after the user registry returns no match, so a user route
 * registered at the same path takes precedence.
 *
 * - `GET /health` -> 200 `{ status: "ok" }`.
 * - `GET /ready` -> 200 `{ status: "ready", routes }`.
 * - `GET /openapi.json` -> 200 application/json with an OpenAPI 3.1 document
 *   (only when `serveOpenApi` is true; the plugin flips this off for
 *   `openapi.expose === "off"` and routes the serving through `gatedBuiltins`
 *   for `"authenticated"`).
 *
 * Returns `null` for any other request so the dispatcher can answer 404.
 */
export function createBuiltins(opts: BuiltinsOptions): BuiltinHandler {
  return function builtinHandler(req: Request, pathname: string) {
    if (req.method !== "GET") return null;

    if (pathname === "/health") {
      return jsonResponse({ status: "ok" }, 200);
    }

    if (pathname === "/ready") {
      return jsonResponse({ status: "ready", routes: opts.registry.size }, 200);
    }

    if (pathname === "/openapi.json" && opts.serveOpenApi) {
      const doc = buildOpenApiDocument(opts.registry);
      return jsonResponse(doc, 200);
    }

    return null;
  };
}

/**
 * The dispatcher hands this handler `/openapi.json` requests after the auth
 * middleware admits. The plugin wires it in via `gatedBuiltins` when
 * `openapi.expose === "authenticated"` and an `auth` strategy is configured.
 */
export function createOpenApiGatedHandler(
  registry: HttpRouteRegistry,
): BuiltinHandler {
  return function openApiHandler(req, pathname) {
    if (req.method !== "GET" || pathname !== "/openapi.json") return null;
    return jsonResponse(buildOpenApiDocument(registry), 200);
  };
}

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
