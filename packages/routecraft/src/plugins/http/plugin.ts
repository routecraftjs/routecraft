import type { CraftContext, CraftPlugin } from "../../context";
import { rcError } from "../../error";
import type {
  HttpAuth,
  HttpMountDefinition,
  HttpPluginOptions,
} from "../../adapters/http/types";
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
  HTTP_MOUNTS,
  HTTP_PLUGIN_REGISTERED,
  type HttpMountRuntime,
  type HttpRouteView,
} from "./registry";
import type { HttpOpenApiInfo } from "./openapi";
import type { HttpWebhookSignatureRejection } from "./webhook-signature";
import { findPackageInfo } from "./package-info";
import { requireWebIngress } from "../server/registry.ts";
import { normalizeStaticPathPrefix } from "../server/mount-path.ts";
import type { PathClaim } from "../server/types.ts";
import { staticPathPrefix } from "./path-matcher.ts";

const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024;

/** Resolved per-mount config after the single-mount sugar is normalised. */
interface ResolvedMount {
  readonly name: string;
  readonly path: string;
  readonly auth: HttpAuth | false | undefined;
}

/**
 * HTTP plugin. Owns the route registries and request dispatchers for its
 * path-scoped mounts, registered on a named server (the listener itself
 * belongs to `defineConfig({ servers })`). Materialised by the config
 * applier so users typically configure it via `defineConfig({ http: {...} })`
 * rather than pushing it onto `config.plugins`. The function is still
 * exported for advanced users who want to wire it manually.
 *
 * The mount is the authentication wall: a mount with an effective validator
 * (its own `auth`, or the server's) requires a valid credential for every
 * route; `auth: false` is a public surface whose routes never see
 * credentials, except routes that declare `.authorize()`, which pull
 * verification through the server validator.
 *
 * Lifecycle:
 *   - `apply(ctx)`: validate options, publish the mount table on the context
 *     store, and mount each dispatcher on the selected named server.
 *   - `teardown(ctx)`: unmount the dispatchers and clear the registries.
 */
export function httpPlugin(options: HttpPluginOptions): CraftPlugin {
  const mountsResolved = validate(options);

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

  const unmounts: Array<() => void> = [];
  const mountRuntimes = new Map<string, HttpMountRuntime>();
  for (const mount of mountsResolved) {
    mountRuntimes.set(mount.name, {
      path: mount.path,
      registry: new Map(),
    });
  }

  // Built-ins (/health, /ready, /openapi.json) report routes across EVERY
  // mount but serve only from the "default" mount when it owns the "/"
  // catch-all; a mounts config without one has no root to serve them from.
  const allRoutes: HttpRouteView = {
    get size() {
      let total = 0;
      for (const runtime of mountRuntimes.values()) {
        total += runtime.registry.size;
      }
      return total;
    },
    *values() {
      for (const runtime of mountRuntimes.values()) {
        yield* runtime.registry.values();
      }
    },
  };

  return {
    async apply(ctx: CraftContext) {
      const ingress = requireWebIngress(ctx, serverName);
      ctx.setStore(HTTP_PLUGIN_REGISTERED, true);
      ctx.setStore(HTTP_MOUNTS, mountRuntimes);

      const onRequestCompleted: RequestCompletedHandler | undefined =
        perRequestEnabled
          ? (event) => ctx.emit("plugin:http:request:completed", { ...event })
          : undefined;

      for (const mount of mountsResolved) {
        const runtime = mountRuntimes.get(mount.name)!;
        const mountId =
          mount.name === "default" ? "http" : `http:${mount.name}`;

        // The shared ingress emits auth:success / auth:rejected when the
        // `authenticate` thunk resolves an admit or a reject; `absent` is
        // neither, so the missing-credential 401 the dispatcher synthesises
        // on a walled mount (or an authorize-pull route) would otherwise be
        // invisible. This hook is the one place that case can still raise
        // the event. Built per mount so every rejection path on one surface
        // reports the same `source` the thunk's events carry.
        const onAuthAbsent = (scheme: string) => {
          ctx.emit("auth:rejected", {
            reason: missingCredentialReason(scheme),
            scheme,
            source: mountId,
          });
        };

        // Signature rejections surface through the same auth:rejected event
        // as credential failures. Wired unconditionally (unlike onAuthAbsent)
        // because the per-route signature gate is independent of the mount
        // wall; a webhook endpoint typically lives on a public mount.
        const onSignatureRejected = (reason: HttpWebhookSignatureRejection) => {
          ctx.emit("auth:rejected", {
            reason,
            scheme: "signature",
            source: mountId,
          });
        };

        // The wall: an effective validator exists and the mount did not opt
        // out. `auth: false` keeps the server validator REACHABLE (for
        // routes that declare .authorize()) while removing the wall, so the
        // ingress mount is registered without `auth: false`; enforcement is
        // entirely this dispatcher's job.
        const hasOwnAuth = mount.auth !== undefined && mount.auth !== false;
        const hasValidator = hasOwnAuth || ingress.serverAuthConfigured;
        const walled = mount.auth !== false && hasValidator;
        const isDefaultRoot = mount.name === "default" && mount.path === "/";
        const authConfigured = walled;

        // Built-ins layering (default-root mount only). See the matrix in
        // HttpBuiltinOptions: /ready and /openapi.json gate on the mount
        // wall being configured.
        const readyLayer: "off" | "public-full" | "auth-aware" =
          !isDefaultRoot || !readyEnabled
            ? "off"
            : readyRequireAuth && authConfigured
              ? "auth-aware"
              : "public-full";
        const openapiServedPublic =
          isDefaultRoot &&
          openapiEnabled &&
          (!openapiRequireAuth || !authConfigured);
        const openapiServedGated =
          isDefaultRoot &&
          openapiEnabled &&
          openapiRequireAuth &&
          authConfigured;

        const builtins = createBuiltins({
          registry: allRoutes,
          serveHealth: isDefaultRoot && healthEnabled,
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
                    ? buildReadyResponse(allRoutes, isAuthenticated)
                    : null,
              }
            : undefined;

        const gatedBuiltins: GatedBuiltins | undefined = openapiServedGated
          ? {
              paths: new Set(["/openapi.json"]),
              handler: createOpenApiGatedHandler(allRoutes, openapiInfo),
            }
          : undefined;

        const dispatcher = createDispatcher({
          registry: runtime.registry,
          walled,
          maxBodySize,
          builtins,
          ...(authAwareBuiltins !== undefined ? { authAwareBuiltins } : {}),
          ...(gatedBuiltins !== undefined ? { gatedBuiltins } : {}),
          ...(onRequestCompleted !== undefined ? { onRequestCompleted } : {}),
          onAuthAbsent,
          onSignatureRejected,
          logger: ctx.logger,
        });
        unmounts.push(
          ingress.mountHttp({
            id: mountId,
            // Never `auth: false` here (see `walled` above): the thunk keeps
            // the inherited validator so authorize-pull works on public
            // mounts; whether it is ever called is the dispatcher's call.
            ...(hasOwnAuth ? { auth: mount.auth as HttpAuth } : {}),
            claims: () => {
              // Routes that demand identity on an unwalled mount need a
              // validator in scope; with none anywhere the route can never
              // serve, so refuse at bind rather than 401 every request.
              if (!walled && !hasValidator) {
                for (const entry of runtime.registry.values()) {
                  if (entry.requiresPrincipal) {
                    throw rcError("RC5003", undefined, {
                      message: `http mount "${mount.name}": route "${entry.routeId}" declares .authorize() but no validator is in scope. Set auth on the mount or on servers.${serverName}.auth.`,
                    });
                  }
                }
              }
              const claims: PathClaim[] = [
                { kind: "prefix", path: mount.path },
              ];
              // Built-ins are answered inside this mount's dispatcher, so
              // without an explicit claim they are invisible to bind-time
              // validation and another surface claiming the same path (the
              // ops plugin's /health) silently wins on score instead of
              // being refused.
              for (const [path, enabled] of [
                ["/health", isDefaultRoot && healthEnabled],
                ["/ready", isDefaultRoot && readyEnabled],
                ["/openapi.json", isDefaultRoot && openapiEnabled],
              ] as const) {
                if (enabled)
                  claims.push({ kind: "exact", path, methods: ["GET"] });
              }
              for (const entry of runtime.registry.values()) {
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
          }),
        );
      }
    },
    async teardown(ctx: CraftContext) {
      for (const unmount of unmounts.splice(0)) {
        try {
          unmount();
        } catch (error) {
          ctx.logger.warn(
            { err: error },
            "HTTP mount failed to unmount cleanly",
          );
        }
      }
      for (const runtime of mountRuntimes.values()) {
        runtime.registry.clear();
      }
      ctx.setStore(HTTP_PLUGIN_REGISTERED, false);
    },
  };
}

function validate(options: HttpPluginOptions): ResolvedMount[] {
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
  if (options.mounts !== undefined && options.auth !== undefined) {
    throw rcError("RC5003", undefined, {
      message:
        "httpPlugin: `auth` and `mounts` are mutually exclusive. Top-level `auth` is sugar for a single default mount; with `mounts`, set auth per mount.",
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

  return resolveMounts(options);
}

function resolveMounts(options: HttpPluginOptions): ResolvedMount[] {
  if (options.mounts === undefined) {
    return [
      {
        name: "default",
        path: "/",
        auth: options.auth,
      },
    ];
  }
  const entries = Object.entries(options.mounts);
  if (entries.length === 0) {
    throw rcError("RC5003", undefined, {
      message: "httpPlugin: `mounts` must declare at least one mount.",
    });
  }
  const seenPaths = new Map<string, string>();
  const resolved: ResolvedMount[] = [];
  for (const [name, definition] of entries) {
    if (!name) {
      throw rcError("RC5003", undefined, {
        message: "httpPlugin: mount names must not be empty",
      });
    }
    const path = normalizeMountPath(name, definition);
    const owner = seenPaths.get(path);
    if (owner !== undefined) {
      throw rcError("RC5003", undefined, {
        message: `httpPlugin: mounts "${owner}" and "${name}" both claim path "${path}".`,
      });
    }
    seenPaths.set(path, name);
    resolved.push({ name, path, auth: definition.auth });
  }
  return resolved;
}

function normalizeMountPath(
  name: string,
  definition: HttpMountDefinition,
): string {
  return normalizeStaticPathPrefix(
    definition.path,
    `httpPlugin: mount "${name}"`,
  );
}
