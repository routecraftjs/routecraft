import { type CraftContext, type CraftPlugin } from "../../context";
import { rcError } from "../../error";
import type { HttpPluginOptions } from "../../adapters/http/types";
import {
  createAuthMiddleware,
  missingCredentialReason,
  type HttpAuthMiddleware,
} from "./auth";
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
import { startServer, type HttpServerHandle } from "./server";

const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024;
const DEFAULT_HOST = "127.0.0.1";

/**
 * HTTP plugin. Owns the runtime HTTP server, the route registry, and the
 * global auth middleware. Materialised by the config applier so users
 * typically configure it via `defineConfig({ http: {...} })` rather than
 * pushing it onto `config.plugins`. The function is still exported for
 * advanced users who want to wire it manually.
 *
 * Lifecycle:
 *   - `apply(ctx)`: validate options, publish the registry on the context
 *     store, start the server (Bun.serve on Bun, node:http on Node), emit
 *     `plugin:http:server:listening`.
 *   - `teardown(ctx)`: close the server, emit `plugin:http:server:closed`,
 *     clear the store flag so a fresh apply() on the same context (test
 *     reuse) starts from a clean slate.
 *
 * @experimental
 */
export function httpPlugin(options: HttpPluginOptions): CraftPlugin {
  validate(options);

  const host = options.host ?? DEFAULT_HOST;
  const maxBodySize = options.maxBodySize ?? DEFAULT_MAX_BODY_SIZE;
  const perRequestEnabled = options.events?.perRequest ?? true;

  // Built-ins config: every endpoint takes the same {enabled, requireAuth}
  // shape. Defaults differ per endpoint (see HttpBuiltinOptions JSDoc).
  const healthEnabled = options.builtins?.health?.enabled ?? true;
  const readyEnabled = options.builtins?.ready?.enabled ?? true;
  const readyRequireAuth = options.builtins?.ready?.requireAuth ?? true;
  const openapiEnabled = options.builtins?.openapi?.enabled ?? true;
  const openapiRequireAuth = options.builtins?.openapi?.requireAuth ?? false;

  let server: HttpServerHandle | null = null;
  const registry: HttpRouteRegistry = new Map();

  return {
    async apply(ctx: CraftContext) {
      // createAuthMiddleware may throw (RC5003 for reserved OAuth sentinel).
      // Set the store only after it succeeds so we never leave registered=true
      // against a server that never started.
      const authMiddleware = createAuthMiddleware(options.auth);
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
        : readyRequireAuth && authMiddleware
          ? "auth-aware"
          : "public-full";

      const openapiServedPublic =
        openapiEnabled && (!openapiRequireAuth || !authMiddleware);
      const openapiServedGated =
        openapiEnabled && openapiRequireAuth && !!authMiddleware;

      const builtins = createBuiltins({
        registry,
        serveHealth: healthEnabled,
        ready: readyLayer === "public-full" ? "full" : "off",
        serveOpenApi: openapiServedPublic,
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
            handler: createOpenApiGatedHandler(registry),
          }
        : undefined;

      const onRequestCompleted: RequestCompletedHandler | undefined =
        perRequestEnabled
          ? (event) => ctx.emit("plugin:http:request:completed", { ...event })
          : undefined;

      // Wrap the auth middleware so admit / reject pipe through the
      // framework's existing auth:* events (same payload shape MCP uses),
      // keeping observability surfaces consistent across plugins. The
      // `absent` variant is deliberately silent: no credential was even
      // attempted, so emitting `auth:rejected` would be misleading. The
      // dispatcher decides whether absent becomes a 401 (required mode) or
      // an anonymous admit (optional mode); either way, no auth event
      // fires for absent.
      const wrappedAuth: HttpAuthMiddleware | undefined = authMiddleware
        ? async (req: Request) => {
            const result = await authMiddleware(req);
            if (result.kind === "admit") {
              ctx.emit("auth:success", {
                subject: result.principal.subject,
                scheme: result.principal.scheme,
                source: "http",
              });
            } else if (result.kind === "reject") {
              ctx.emit("auth:rejected", {
                reason: result.reason,
                scheme: result.scheme,
                source: "http",
              });
            }
            return result;
          }
        : undefined;

      // The dispatcher itself synthesises the missing-credential 401 for
      // `auth: "required"` routes (the middleware returns `absent` instead
      // of `reject` so optional routes can admit anonymously). We still
      // want `auth:rejected` to fire for that case, so wire it here in the
      // same place the middleware wrapper emits the per-result events.
      const onAuthAbsent = authMiddleware
        ? (scheme: string) => {
            ctx.emit("auth:rejected", {
              reason: missingCredentialReason(scheme),
              scheme,
              source: "http",
            });
          }
        : undefined;

      const dispatcher = createDispatcher({
        registry,
        authMiddleware: wrappedAuth,
        maxBodySize,
        builtins,
        ...(authAwareBuiltins !== undefined ? { authAwareBuiltins } : {}),
        ...(gatedBuiltins !== undefined ? { gatedBuiltins } : {}),
        ...(onRequestCompleted !== undefined ? { onRequestCompleted } : {}),
        ...(onAuthAbsent !== undefined ? { onAuthAbsent } : {}),
        logger: ctx.logger,
      });

      try {
        server = await startServer({
          port: options.port,
          host,
          fetch: dispatcher,
        });
      } catch (err) {
        // Bind failed (e.g. RC5019 port in use). apply() rejects before a
        // teardown is registered, so undo the store mutations here to keep
        // the invariant "registered implies a live server" -- otherwise a
        // retried apply() (test reuse) or a source subscribe would see a
        // stale `registered === true` against a server that never started.
        registry.clear();
        ctx.setStore(HTTP_PLUGIN_REGISTERED, false);
        throw err;
      }

      ctx.emit("plugin:http:server:listening", {
        port: server.port,
        host,
      });

      ctx.registerTeardown(async () => {
        if (!server) return;
        const handle = server;
        server = null;
        try {
          await handle.close();
        } catch (err) {
          ctx.logger.warn(
            { err, operation: "close" },
            "http plugin: failed to close server cleanly",
          );
        }
        ctx.emit("plugin:http:server:closed", {});
        registry.clear();
        ctx.setStore(HTTP_PLUGIN_REGISTERED, false);
      });
    },
  };
}

function validate(options: HttpPluginOptions): void {
  if (
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535
  ) {
    throw rcError("RC5003", undefined, {
      message: `httpPlugin: invalid port ${String(options.port)}. Pass a 0-65535 integer (0 lets the OS choose).`,
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
}
