import type { BuiltinHandler } from "./dispatcher";
import { buildOpenApiDocument } from "./openapi";
import type { HttpRouteRegistry } from "./registry";

export interface BuiltinsOptions {
  registry: HttpRouteRegistry;
  info?: { title?: string; version?: string };
}

/**
 * Always-on endpoints registered before user routes. The dispatcher consults
 * built-ins only after the user registry returns no match, so a user route
 * registered at the same path takes precedence.
 *
 * - `GET /health` -> 200 `{ status: "ok" }`.
 * - `GET /ready` -> 200 `{ status: "ready", routes }`.
 * - `GET /openapi.json` -> 200 application/json with an OpenAPI 3.1 document
 *   describing every registered route. Body and response schemas are stubs in
 *   v1 (see openapi.ts for the rationale).
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

    if (pathname === "/openapi.json") {
      const doc = buildOpenApiDocument(opts.registry, opts.info);
      return jsonResponse(doc, 200);
    }

    return null;
  };
}

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
