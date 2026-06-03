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

/**
 * `info` block of an OpenAPI 3.1 document. Mirrors the OpenAPI Info Object
 * shape (`title`, `version`, optional `description`, `contact`, `license`).
 *
 * Defaults are auto-detected from the host project's `package.json` at
 * plugin apply time:
 *
 * - `title`   -> `package.json` `name` (literal, including any `@scope/`).
 * - `version` -> `package.json` `version`.
 *
 * Description / contact / license are **not** auto-pulled even when
 * present in `package.json`: those fields commonly carry internal
 * context (TODO notes, author emails, license boilerplate) that should
 * not leak into a publicly served document by default. Set them
 * explicitly to publish them.
 *
 * Any explicit field passed by the caller wins over the auto-detected
 * default; missing `package.json` falls back to the hardcoded "Routecraft
 * HTTP API" / "0.0.0".
 */
export interface HttpOpenApiInfo {
  title?: string;
  version?: string;
  description?: string;
  contact?: { name?: string; url?: string; email?: string };
  license?: { name: string; identifier?: string; url?: string };
}

interface OpenApiDocument {
  openapi: "3.1.0";
  info: HttpOpenApiInfo & { title: string; version: string };
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
  info?: HttpOpenApiInfo,
): OpenApiDocument {
  const resolvedInfo: HttpOpenApiInfo & { title: string; version: string } = {
    title: info?.title ?? "Routecraft HTTP API",
    version: info?.version ?? "0.0.0",
  };
  if (info?.description) resolvedInfo.description = info.description;
  if (info?.contact) resolvedInfo.contact = info.contact;
  if (info?.license) resolvedInfo.license = info.license;

  const doc: OpenApiDocument = {
    openapi: "3.1.0",
    info: resolvedInfo,
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
  // Match any non-empty param name that doesn't contain `/` or `{}`; this
  // covers all names the path-matcher accepts (including hyphens etc.).
  return pattern.replace(/:([^/{}]+)/g, "{$1}");
}

/**
 * Re-export for ergonomic typing inside the tests.
 */
export type { HttpRouteEntry, HttpRouteRegistry };
