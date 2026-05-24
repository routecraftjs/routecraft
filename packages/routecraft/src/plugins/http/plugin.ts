import { type CraftContext, type CraftPlugin } from "../../context";
import { rcError } from "../../error";
import type { HttpPluginOptions } from "../../adapters/http/types";
import { createAuthMiddleware, type HttpAuthMiddleware } from "./auth";
import { createBuiltins } from "./builtins";
import { createDispatcher, type RequestCompletedHandler } from "./dispatcher";
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

  let server: HttpServerHandle | null = null;
  const registry: HttpRouteRegistry = new Map();

  return {
    async apply(ctx: CraftContext) {
      ctx.setStore(
        HTTP_PLUGIN_REGISTERED as keyof import("@routecraft/routecraft").StoreRegistry,
        true,
      );
      ctx.setStore(
        HTTP_ROUTE_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry,
        registry,
      );

      const authMiddleware = createAuthMiddleware(options.auth);
      const builtins = createBuiltins({ registry });

      const onRequestCompleted: RequestCompletedHandler | undefined =
        perRequestEnabled
          ? (event) => ctx.emit("plugin:http:request:completed", { ...event })
          : undefined;

      // Wrap the auth middleware so admit/reject also pipes through the
      // framework's existing auth:* events (same payload shape MCP uses),
      // keeping observability surfaces consistent across plugins.
      const wrappedAuth: HttpAuthMiddleware | undefined = authMiddleware
        ? async (req: Request) => {
            const result = await authMiddleware(req);
            if (result.kind === "admit") {
              ctx.emit("auth:success", {
                subject: result.principal?.subject ?? "anonymous",
                scheme: result.principal?.scheme ?? "unknown",
                source: "http",
              });
            } else {
              ctx.emit("auth:rejected", {
                reason: result.reason,
                scheme: result.scheme,
                source: "http",
              });
            }
            return result;
          }
        : undefined;

      const dispatcher = createDispatcher({
        registry,
        authMiddleware: wrappedAuth,
        maxBodySize,
        builtins,
        ...(onRequestCompleted !== undefined ? { onRequestCompleted } : {}),
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
        ctx.setStore(
          HTTP_PLUGIN_REGISTERED as keyof import("@routecraft/routecraft").StoreRegistry,
          false,
        );
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
        ctx.setStore(
          HTTP_PLUGIN_REGISTERED as keyof import("@routecraft/routecraft").StoreRegistry,
          false,
        );
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
}
