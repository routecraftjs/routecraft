import type { CraftContext, CraftPlugin } from "../../context";
import { rcError } from "../../error";
import type { HttpPluginOptions } from "../../adapters/http/types";
import { missingCredentialReason } from "./auth";
import {
  buildReadyResponse,
  createBuiltins,
  createOpenApiGatedHandler,
} from "./builtins";
import {
  createDispatcher,
  type AuthAwareBuiltins,
  type GatedBuiltins,
  type RequestCompletedHandler,
} from "./dispatcher";
import {
  HTTP_PLUGIN_REGISTERED,
  HTTP_ROUTE_REGISTRY,
  type HttpRouteRegistry,
} from "./registry";
import type { HttpOpenApiInfo } from "./openapi";
import type { HttpWebhookSignatureRejection } from "./webhook-signature";
import { findPackageInfo } from "./package-info";
import { requireWebIngress } from "../server/registry.ts";
import type { PathClaim } from "../server/types.ts";
import { staticPathPrefix } from "./path-matcher.ts";

const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024;

/**
 * HTTP plugin. Owns the route registry and the request dispatcher, and
 * mounts them as the catch-all surface on a named server (the listener
 * itself belongs to `defineConfig({ servers })`). Materialised by the
 * config applier so users typically configure it via
 * `defineConfig({ http: {...} })` rather than pushing it onto
 * `config.plugins`. The function is still exported for advanced users who
 * want to wire it manually.
 *
 * Lifecycle:
 *   - `apply(ctx)`: validate options, publish the registry on the context
 *     store, and mount the dispatcher on the selected named server.
 *   - `teardown(ctx)`: unmount the dispatcher and clear the route registry.
 *
 * @experimental
 */
export function httpPlugin(options: HttpPluginOptions): CraftPlugin {
  validate(options);

  const serverName = options.server ?? "default";
  const maxBodySize = options.maxBodySize ?? DEFAULT_MAX_BODY_SIZE;
  const perRequestEnabled = options.events?.perRequest ?? true;

  // Built-ins config: every endpoint takes the same {enabled, requireAuth}
  // shape. Defaults differ per endpoint (see HttpBuiltinOptions JSDoc).
  const healthEnabled = options.builtins?.health?.enabled ?? true;
  const readyEnabled = options.builtins?.ready?.enabled ?? true;
  const readyRequireAuth = options.builtins?.ready?.requireAuth ?? true;
  const openapiEnabled = options.builtins?.openapi?.enabled ?? true;
  const openapiRequireAuth = options.builtins?.openapi?.requireAuth ?? false;

  // Resolve the OpenAPI `info` block once: auto-detect `title` (name) and
  // `version` from the nearest package.json, then layer the caller's
  // explicit overrides on top. Description / contact / license are NOT
  // auto-pulled (see HttpOpenApiInfo JSDoc for the security rationale).
  // Skip the fs walk entirely when openapi is disabled.
  const openapiInfoOverride = options.builtins?.openapi?.info;
  const pkg = openapiEnabled ? findPackageInfo() : {};
  const openapiInfo: HttpOpenApiInfo = {
    ...(pkg.name !== undefined ? { title: pkg.name } : {}),
    ...(pkg.version !== undefined ? { version: pkg.version } : {}),
    ...(openapiInfoOverride ?? {}),
  };

  let unmount: (() => void) | null = null;
  const registry: HttpRouteRegistry = new Map();

  return {
    async apply(ctx: CraftContext) {
      const ingress = requireWebIngress(ctx, serverName);
      const authConfigured =
        (options.auth !== undefined && options.auth !== false) ||
        (options.auth !== false && ingress.serverAuthConfigured);
      ctx.setStore(HTTP_PLUGIN_REGISTERED, true);
      ctx.setStore(HTTP_ROUTE_REGISTRY, registry);

      // Decide which built-ins layer each path goes through.
      //
      // /ready:
      //   requireAuth=false -> public layer, full body
      //   requireAuth=true && auth configured -> auth-aware layer (200
      //     always; anon gets minimal, authed gets full)
      //   requireAuth=true && no auth configured -> public layer, full
      //     body (collapses because there is nothing to gate against)
      //
      // /openapi.json:
      //   requireAuth=false -> public layer (anyone)
      //   requireAuth=true && auth configured -> gated layer (401 to anon)
      //   requireAuth=true && no auth configured -> public layer (collapses)
      const readyLayer: "off" | "public-full" | "auth-aware" = !readyEnabled
        ? "off"
        : readyRequireAuth && authConfigured
          ? "auth-aware"
          : "public-full";

      const openapiServedPublic =
        openapiEnabled && (!openapiRequireAuth || !authConfigured);
      const openapiServedGated =
        openapiEnabled && openapiRequireAuth && authConfigured;

      const builtins = createBuiltins({
        registry,
        serveHealth: healthEnabled,
        ready: readyLayer === "public-full" ? "full" : "off",
        serveOpenApi: openapiServedPublic,
        openapiInfo,
      });

      const authAwareBuiltins: AuthAwareBuiltins | undefined =
        readyLayer === "auth-aware"
          ? {
              paths: new Set(["/ready"]),
              handler: (_req, pathname, isAuthenticated) =>
                pathname === "/ready"
                  ? buildReadyResponse(registry, isAuthenticated)
                  : null,
            }
          : undefined;

      const gatedBuiltins: GatedBuiltins | undefined = openapiServedGated
        ? {
            paths: new Set(["/openapi.json"]),
            handler: createOpenApiGatedHandler(registry, openapiInfo),
          }
        : undefined;

      const onRequestCompleted: RequestCompletedHandler | undefined =
        perRequestEnabled
          ? (event) => ctx.emit("plugin:http:request:completed", { ...event })
          : undefined;

      // The shared ingress emits auth:success / auth:rejected when the
      // `authenticate` thunk resolves an admit or a reject; `absent` is
      // neither, so the missing-credential 401 the dispatcher synthesises
      // for `auth: "required"` routes would otherwise be invisible. This
      // hook is the one place that case can still raise the event.
      const onAuthAbsent = authConfigured
        ? (scheme: string) => {
            ctx.emit("auth:rejected", {
              reason: missingCredentialReason(scheme),
              scheme,
              source: "http",
            });
          }
        : undefined;

      // Signature rejections surface through the same auth:rejected event
      // as credential failures. Wired unconditionally (unlike onAuthAbsent)
      // because the per-route signature gate is independent of the global
      // auth middleware; a webhook endpoint typically pairs it with
      // auth: "skip".
      const onSignatureRejected = (reason: HttpWebhookSignatureRejection) => {
        ctx.emit("auth:rejected", {
          reason,
          scheme: "signature",
          source: "http",
        });
      };

      const dispatcher = createDispatcher({
        registry,
        maxBodySize,
        builtins,
        ...(authAwareBuiltins !== undefined ? { authAwareBuiltins } : {}),
        ...(gatedBuiltins !== undefined ? { gatedBuiltins } : {}),
        ...(onRequestCompleted !== undefined ? { onRequestCompleted } : {}),
        ...(onAuthAbsent !== undefined ? { onAuthAbsent } : {}),
        onSignatureRejected,
        logger: ctx.logger,
      });
      unmount = ingress.mountHttp({
        id: "http",
        ...(options.auth !== undefined ? { auth: options.auth } : {}),
        claims: () => {
          const claims: PathClaim[] = [{ kind: "prefix", path: "/" }];
          for (const entry of registry.values()) {
            claims.push({
              kind: "pattern",
              matcher: entry.matcher,
              staticPrefix: staticPathPrefix(entry.matcher.pattern),
              methods: [entry.method],
            });
          }
          return claims;
        },
        handler: (request, mountContext) =>
          dispatcher(request, mountContext.authenticate),
      });
    },
    async teardown(ctx: CraftContext) {
      try {
        unmount?.();
      } catch (error) {
        ctx.logger.warn({ err: error }, "HTTP mount failed to unmount cleanly");
      } finally {
        unmount = null;
        registry.clear();
        ctx.setStore(HTTP_PLUGIN_REGISTERED, false);
      }
    },
  };
}

function validate(options: HttpPluginOptions): void {
  const removed = options as HttpPluginOptions & {
    port?: unknown;
    host?: unknown;
  };
  if (removed.port !== undefined || removed.host !== undefined) {
    throw rcError("RC5003", undefined, {
      message:
        'httpPlugin: `port` and `host` were removed. Define `servers.default: { host, port }` and use `http: { server: "default" }`.',
    });
  }
  if (options.server !== undefined && options.server.length === 0) {
    throw rcError("RC5003", undefined, {
      message: "httpPlugin: server name must not be empty",
    });
  }
  if (
    options.maxBodySize !== undefined &&
    (!Number.isInteger(options.maxBodySize) || options.maxBodySize <= 0)
  ) {
    throw rcError("RC5003", undefined, {
      message: `httpPlugin: invalid maxBodySize ${String(options.maxBodySize)}. Pass a positive integer (bytes).`,
    });
  }
  for (const name of ["health", "ready", "openapi"] as const) {
    const entry = options.builtins?.[name];
    if (entry === undefined) continue;
    // Guard against `builtins: { openapi: false as any }` slipping through:
    // without this check, apply() would silently fall back to the defaults
    // (and leave /openapi.json publicly exposed).
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw rcError("RC5003", undefined, {
        message: `httpPlugin: invalid builtins.${name} ${JSON.stringify(
          entry,
        )}. Pass an object with optional { enabled, requireAuth } fields.`,
      });
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
      throw rcError("RC5003", undefined, {
        message: `httpPlugin: invalid builtins.${name}.enabled ${JSON.stringify(
          entry.enabled,
        )}. Pass a boolean.`,
      });
    }
    if (
      entry.requireAuth !== undefined &&
      typeof entry.requireAuth !== "boolean"
    ) {
      throw rcError("RC5003", undefined, {
        message: `httpPlugin: invalid builtins.${name}.requireAuth ${JSON.stringify(
          entry.requireAuth,
        )}. Pass a boolean.`,
      });
    }
  }
  const openapiInfo = options.builtins?.openapi?.info;
  if (openapiInfo !== undefined) {
    if (
      typeof openapiInfo !== "object" ||
      openapiInfo === null ||
      Array.isArray(openapiInfo)
    ) {
      throw rcError("RC5003", undefined, {
        message: `httpPlugin: invalid builtins.openapi.info ${JSON.stringify(
          openapiInfo,
        )}. Pass an OpenAPI Info Object (e.g. { title, version, description }).`,
      });
    }
  }
}
