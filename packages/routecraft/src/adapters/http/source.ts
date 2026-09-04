import type { CraftPlugin } from "../../context";
import { rcError } from "../../error";
import type { Source, Subscription } from "../../operations/from";
import {
  HTTP_MOUNTS,
  HTTP_PLUGIN_REGISTERED,
  type HttpMountRuntime,
  type HttpRouteEntry,
} from "../../plugins/http/registry";
import { compilePathMatcher } from "../../plugins/http/path-matcher";
import { METHODS_WITHOUT_BODY } from "../../plugins/http/body-parser";
import { invalidSignatureOptionsReason } from "../../plugins/http/webhook-signature";
import type { HttpMethod, HttpRequestBody, HttpServerOptions } from "./types";

const HTTP_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

/**
 * Resolve the route's method, defaulting to GET and upper-casing so an
 * untyped JS caller passing `method: "post"` matches the dispatcher's
 * uppercase comparison instead of silently registering a route that can
 * never match a request. Anything outside the supported set (including
 * non-strings squeezed past the types) fails RC5003 at the http({...})
 * call site rather than registering a dead route.
 */
function normalizeMethod(options: HttpServerOptions): HttpMethod {
  const method = options.method ?? "GET";
  const normalized =
    typeof method === "string" ? method.toUpperCase() : undefined;
  if (normalized === undefined || !HTTP_METHODS.has(normalized)) {
    throw rcError("RC5003", undefined, {
      message: `http() source: invalid method ${String(method)}. Allowed: ${[...HTTP_METHODS].map((m) => `"${m}"`).join(", ")}.`,
    });
  }
  return normalized as HttpMethod;
}

/**
 * Refuse a `respond` that is not callable. An options object built
 * programmatically (or by an untyped caller) would otherwise register a route
 * whose responder throws on the first request, which is a 500 per delivery
 * rather than a boot failure.
 */
function assertRespondCallable(options: HttpServerOptions): void {
  if (options.respond !== undefined && typeof options.respond !== "function") {
    throw rcError("RC5003", undefined, {
      message: `http() source: respond must be a function, received ${typeof options.respond}. It is called once per request and returns the response to send, e.g. respond: () => ({ status: 202 }).`,
    });
  }
}

/**
 * Join a mount prefix and a mount-relative route path into the full request
 * pattern. `"/"` plus `"/orders"` is `/orders`; `"/api"` plus `"/orders"`
 * is `/api/orders`.
 */
function joinMountPath(mountPath: string, routePath: string): string {
  const prefix = mountPath === "/" ? "" : mountPath.replace(/\/+$/, "");
  const suffix = routePath.startsWith("/") ? routePath : `/${routePath}`;
  return `${prefix}${suffix}` || "/";
}

// Surface CraftPlugin in the public types of this module so consumers that
// only import the source adapter still see the symbol (without re-exporting
// the whole plugin entry point).
export type { CraftPlugin };

/**
 * Source adapter exposed by `http({ path, method })` when used with
 * `.from(...)`. Registers itself in the http plugin's registry on
 * subscribe; deregisters on abort. The plugin owns the listener, the auth
 * middleware, and the dispatcher -- this adapter is just the entry that
 * tells the dispatcher "this route claims this path/method".
 */
export class HttpSourceAdapter implements Source<HttpRequestBody> {
  readonly adapterId = "routecraft.adapter.http.source";

  constructor(private readonly options: HttpServerOptions) {
    // Validate the method unconditionally so an unsupported or non-string
    // method fails here, not as a dead route at subscribe time.
    normalizeMethod(options);
    assertRespondCallable(options);

    // Auth is mount-owned; the removed per-route auth modes fail loudly so
    // an untyped caller migrating from 0.6 learns the new model instead of
    // silently keeping a knob that no longer exists.
    const legacyAuth = (options as { auth?: unknown }).auth;
    if (legacyAuth !== undefined) {
      throw rcError("RC5003", undefined, {
        message:
          "http() source: per-route `auth` was removed. The mount decides authentication: put public routes on a mount with `auth: false`, walled routes on a mount with a validator, and use `.authorize()` on a route that needs identity on a public mount.",
      });
    }

    if (options.mount !== undefined && options.mount.length === 0) {
      throw rcError("RC5003", undefined, {
        message: "http() source: mount name must not be empty",
      });
    }

    if (options.signature !== undefined) {
      // The body parser skips METHODS_WITHOUT_BODY entirely, which would
      // silently skip verification too. A signature gate on a route that
      // never has a body to sign is a configuration error; fail at the
      // http({...}) call site, not at the first delivery. Checking the
      // shared set (not a local copy) keeps this guard in lockstep with
      // the parser's skip.
      const method = normalizeMethod(this.options);
      if (METHODS_WITHOUT_BODY.has(method)) {
        throw rcError("RC5003", undefined, {
          message: `http() source: signature verification requires a body-bearing method, got "${method}". Webhook providers sign the request body; use POST, PUT, or PATCH.`,
        });
      }
      const invalid = invalidSignatureOptionsReason(options.signature);
      if (invalid !== null) {
        throw rcError("RC5003", undefined, {
          message: `http() source: ${invalid}`,
        });
      }
    }
  }

  async subscribe(sub: Subscription<HttpRequestBody>): Promise<void> {
    const { context, meta } = sub;
    const registered = context.getStore(HTTP_PLUGIN_REGISTERED);
    if (registered !== true) {
      throw rcError("RC5003", undefined, {
        message:
          "http() source requires the http plugin. Add `servers: { default: { port: 8080 } }, http: {}` to defineConfig({...}).",
      });
    }
    const mounts: ReadonlyMap<string, HttpMountRuntime> | undefined =
      context.getStore(HTTP_MOUNTS);
    if (!mounts) {
      throw rcError("RC5003", undefined, {
        message:
          "http() source: mount table missing from context store. The http plugin failed to initialise.",
      });
    }

    // No silent fallback: an omitted `mount` resolves only to a mount
    // literally named "default", so a forgotten mount name can never land a
    // route on an unintended surface.
    const mountName = this.options.mount ?? "default";
    const mount = mounts.get(mountName);
    if (!mount) {
      const names = [...mounts.keys()].map((n) => `"${n}"`).join(", ");
      throw rcError("RC5003", undefined, {
        message:
          this.options.mount === undefined
            ? `http() source: no mount named "default" exists; declare mount explicitly. Configured mounts: ${names}.`
            : `http() source: mount "${mountName}" is not configured. Configured mounts: ${names}.`,
      });
    }
    const registry = mount.registry;

    const respond = this.options.respond;
    if (respond !== undefined && meta?.bufferedConsumer === true) {
      // A buffering consumer parks the message instead of starting the
      // pipeline, so the route never counts it as in flight and a graceful
      // shutdown drains past it: an answer already sent would outlive the
      // delivery, and a sender that received one does not redeliver. Nothing
      // here can tell whether this particular responder would have awaited
      // the pipeline, because that is decided inside the function at request
      // time, so the refusal covers every responder.
      throw rcError("RC5003", undefined, {
        message:
          "http() source: respond cannot be combined with a batching route. A batched message waits in the buffer instead of running, so it is not in-flight work and a graceful shutdown discards it, while the responder has already answered. Drop .batch() from this route, or drop respond and let the framework answer with the pipeline's result.",
      });
    }

    const method = normalizeMethod(this.options);
    // Route paths are relative to the mount prefix; the matcher covers the
    // full request path so dispatch and OpenAPI need no join at read time.
    const matcher = compilePathMatcher(
      joinMountPath(mount.path, this.options.path),
    );
    const routeId = meta?.routeId ?? `http:${method}:${matcher.pattern}`;
    const entry: HttpRouteEntry = {
      routeId,
      method,
      matcher,
      requiresPrincipal: meta?.requiresPrincipal === true,
      rawBody: this.options.rawBody ?? false,
      signature: this.options.signature,
      respond,
      discovery: meta?.discovery,
      handler: (body, headers) =>
        sub.emit({
          message: body as HttpRequestBody,
          ...(headers ? { headers } : {}),
        }),
    };

    if (registry.has(routeId)) {
      throw rcError("RC5003", undefined, {
        message: `http() source: duplicate route id "${routeId}"`,
      });
    }
    for (const existing of registry.values()) {
      if (
        existing.method === method &&
        existing.matcher.pattern === matcher.pattern
      ) {
        throw rcError("RC5003", undefined, {
          message: `http() source: duplicate route ${method} ${matcher.pattern} (already claimed by "${existing.routeId}")`,
        });
      }
    }
    registry.set(routeId, entry);

    sub.ready();

    // Hold the subscription open until the route is aborted. The dispatcher
    // calls our entry's handler for each incoming request; no per-request
    // work happens here.
    await new Promise<void>((resolve) => {
      if (sub.signal.aborted) {
        registry.delete(routeId);
        resolve();
        return;
      }
      sub.signal.addEventListener(
        "abort",
        () => {
          registry.delete(routeId);
          resolve();
        },
        { once: true },
      );
    });
  }
}
