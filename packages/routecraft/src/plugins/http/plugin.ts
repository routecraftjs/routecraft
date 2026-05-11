import { type CraftContext, type CraftPlugin } from "../../context";
import { type EventName } from "../../types";
import { rcError } from "../../error";
import type { HttpPluginOptions } from "../../adapters/http/types";
import { createAuthMiddleware } from "./auth";
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
          ? (event) =>
              ctx.emit(
                "plugin:http:request:completed" as EventName,
                event as Record<string, unknown>,
              )
          : undefined;

      // Wrap the auth middleware so admit/reject also pipes through the
      // existing auth:* events that MCP already emits, keeping observability
      // surfaces consistent across plugins.
      const wrappedAuth = authMiddleware
        ? async (req: Request) => {
            const result = await authMiddleware(req);
            if (result.kind === "admit") {
              ctx.emit(
                "auth:success" as EventName,
                {
                  principal: result.principal,
                } as Record<string, unknown>,
              );
            } else {
              ctx.emit(
                "auth:rejected" as EventName,
                {
                  reason: "auth-failed",
                  statusCode: result.response.status,
                } as Record<string, unknown>,
              );
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

      server = await startServer({
        port: options.port,
        host,
        fetch: dispatcher,
      });

      ctx.emit(
        "plugin:http:server:listening" as EventName,
        {
          port: server.port,
          host,
        } as Record<string, unknown>,
      );

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
        ctx.emit(
          "plugin:http:server:closed" as EventName,
          {} as Record<string, unknown>,
        );
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
