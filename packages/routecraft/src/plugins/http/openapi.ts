import type { HttpRouteEntry, HttpRouteRegistry } from "./registry";

interface OpenApiParameter {
  name: string;
  in: "path";
  required: true;
  schema: { type: "string" };
}

interface OpenApiOperation {
  operationId: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  responses: Record<string, { description: string }>;
}

type OpenApiMethod =
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete"
  | "head"
  | "options";

interface OpenApiPathItem {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
  head?: OpenApiOperation;
  options?: OpenApiOperation;
}

interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string };
  paths: Record<string, OpenApiPathItem>;
}

/**
 * Translate the http plugin's route registry into an OpenAPI 3.1 document.
 *
 * Best-effort by design in v1: paths, methods, summaries, descriptions, and
 * path-parameter slots are all emitted, but request/response body schemas
 * come back as the empty schema `{}` because Standard Schema does not
 * define a generic `toJsonSchema()`. The follow-up issue will plug in
 * optional-peer converters (`@valibot/to-json-schema`, `zod-to-json-schema`,
 * etc.) via `loadOptionalPeer`.
 */
export function buildOpenApiDocument(
  registry: HttpRouteRegistry,
  info?: { title?: string; version?: string },
): OpenApiDocument {
  const doc: OpenApiDocument = {
    openapi: "3.1.0",
    info: {
      title: info?.title ?? "Routecraft HTTP API",
      version: info?.version ?? "0.0.0",
    },
    paths: {},
  };

  for (const entry of registry.values()) {
    const path = patternToOpenApi(entry.matcher.pattern);
    const method = entry.method.toLowerCase() as OpenApiMethod;
    const item = (doc.paths[path] ??= {});
    const op: OpenApiOperation = {
      operationId: entry.routeId,
      responses: {
        "200": { description: "Successful response" },
        "204": { description: "No content" },
        "400": { description: "Bad request" },
        "401": { description: "Unauthorized" },
        "403": { description: "Forbidden" },
        "404": { description: "Not found" },
        "405": { description: "Method not allowed" },
        "413": { description: "Payload too large" },
        "500": { description: "Internal server error" },
      },
    };
    const summary = entry.discovery?.title;
    if (summary) op.summary = summary;
    const description = entry.discovery?.description;
    if (description) op.description = description;
    if (entry.matcher.paramNames.length > 0) {
      op.parameters = entry.matcher.paramNames.map<OpenApiParameter>(
        (name) => ({
          name,
          in: "path",
          required: true,
          schema: { type: "string" },
        }),
      );
    }
    item[method] = op;
  }

  return doc;
}

/**
 * Convert a routecraft pattern (`:param`) into the OpenAPI form (`{param}`).
 * Trailing slashes are preserved as-is since OpenAPI treats `/x` and `/x/`
 * as distinct paths.
 */
function patternToOpenApi(pattern: string): string {
  return pattern.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/**
 * Re-export for ergonomic typing inside the tests.
 */
export type { HttpRouteEntry, HttpRouteRegistry };
