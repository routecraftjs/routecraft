import type { CraftContext } from "../../context.ts";
import { rcError } from "../../error.ts";
import type { HttpMethod } from "../../adapters/http/types.ts";
import type {
  HttpMount,
  HttpMountAuth,
  HttpMountAuthPolicy,
  PathClaim,
  WebIngress,
} from "./types.ts";
import type { ValidatorAuthOptions } from "../../auth/types.ts";
import {
  createAuthMiddleware,
  type AuthResult,
  type HttpAuthMiddleware,
} from "../http/auth.ts";

export const WEB_INGRESSES: unique symbol = Symbol.for(
  "routecraft.plugin.server.web-ingresses",
);

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [WEB_INGRESSES]: ReadonlyMap<string, WebIngress>;
  }
}

const ALL_METHODS: readonly HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

function methodsOf(claim: PathClaim): readonly HttpMethod[] {
  return claim.kind === "prefix" ? ALL_METHODS : (claim.methods ?? ALL_METHODS);
}

function methodsOverlap(a: PathClaim, b: PathClaim): boolean {
  const right = new Set(methodsOf(b));
  return methodsOf(a).some((method) => right.has(method));
}

function prefixContains(prefix: string, path: string): boolean {
  if (prefix === "/") return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

function patternsOverlap(left: string, right: string): boolean {
  const a = left.replace(/\/+$/, "").split("/").filter(Boolean);
  const b = right.replace(/\/+$/, "").split("/").filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((segment, index) => {
    const other = b[index]!;
    return (
      segment.startsWith(":") || other.startsWith(":") || segment === other
    );
  });
}

/**
 * A pattern has a fixed segment count, so it reaches into a prefix claim only
 * when it is at least as deep as the prefix and its leading segments can
 * match the prefix's literals. Comparing on the pattern's static prefix alone
 * would flag `/api/:id` against the disjoint mount `/api/v1/deep`, and a
 * literal root route (static prefix `/`) against every mount.
 */
function patternOverlapsPrefix(pattern: string, prefixPath: string): boolean {
  const patternSegments = pattern
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  const prefixSegments = prefixPath
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  if (patternSegments.length < prefixSegments.length) return false;
  return prefixSegments.every((segment, index) => {
    const candidate = patternSegments[index]!;
    return candidate.startsWith(":") || candidate === segment;
  });
}

function claimsOverlap(a: PathClaim, b: PathClaim): boolean {
  if (!methodsOverlap(a, b)) return false;
  if (a.kind === "exact" && b.kind === "exact") return a.path === b.path;
  if (a.kind === "exact" && b.kind === "pattern") {
    return b.matcher.match(a.path) !== null;
  }
  if (a.kind === "pattern" && b.kind === "exact") {
    return a.matcher.match(b.path) !== null;
  }
  if (a.kind === "exact" && b.kind === "prefix") {
    if (b.path === "/") return false;
    return prefixContains(b.path, a.path);
  }
  if (a.kind === "prefix" && b.kind === "exact") {
    if (a.path === "/") return false;
    return prefixContains(a.path, b.path);
  }
  if (a.kind === "prefix" && b.kind === "prefix") {
    if (a.path === "/" || b.path === "/") return false;
    return prefixContains(a.path, b.path) || prefixContains(b.path, a.path);
  }
  if (a.kind === "pattern" && b.kind === "prefix") {
    if (b.path === "/") return false;
    return patternOverlapsPrefix(a.matcher.pattern, b.path);
  }
  if (a.kind === "prefix" && b.kind === "pattern") {
    return claimsOverlap(b, a);
  }
  if (a.kind === "pattern" && b.kind === "pattern") {
    return patternsOverlap(a.matcher.pattern, b.matcher.pattern);
  }
  return false;
}

function describeClaim(claim: PathClaim): string {
  const methods = methodsOf(claim).join(",");
  if (claim.kind === "pattern") return `${methods} ${claim.matcher.pattern}`;
  return `${methods} ${claim.path}${claim.kind === "prefix" ? "/*" : ""}`;
}

/**
 * Dispatch tiers: an exact claim always beats a pattern, a pattern always
 * beats a prefix, and the `/` fallback (length 1) loses to every other
 * prefix. Within a tier, the longer static path wins.
 */
function scoreClaim(claim: PathClaim, path: string): number | undefined {
  if (claim.kind === "exact") {
    return claim.path === path ? 1_000_000 + path.length : undefined;
  }
  if (claim.kind === "pattern") {
    return claim.matcher.match(path)
      ? 500_000 + claim.staticPrefix.length
      : undefined;
  }
  return prefixContains(claim.path, path) ? claim.path.length : undefined;
}

export class HttpMountRegistry implements WebIngress {
  readonly serverName: string;
  boundAddress: { readonly host: string; readonly port: number } | undefined;
  private readonly mounts = new Map<string, HttpMount>();
  private readonly serverAuth: ValidatorAuthOptions | undefined;
  private readonly context: CraftContext;
  private readonly authByMount = new Map<
    string,
    HttpAuthMiddleware | undefined
  >();
  private readonly authPolicyByMount = new Map<
    string,
    HttpMountAuthPolicy | undefined
  >();
  private evaluatedClaims: ReadonlyArray<{
    mount: HttpMount;
    claims: readonly PathClaim[];
  }> = [];
  private validated = false;

  constructor(
    serverName: string,
    context: CraftContext,
    serverAuth?: ValidatorAuthOptions,
  ) {
    this.serverName = serverName;
    this.context = context;
    this.serverAuth = serverAuth;
  }

  resolveMountAuth(auth: HttpMount["auth"]): HttpMountAuth {
    const own = auth !== undefined && auth !== false;
    const optedOut = auth === false;
    // `false` keeps the inherited validator: it removes the wall, not the
    // ability of a route's .authorize() to pull identity through it.
    const configured = own || this.serverAuth !== undefined;
    return { configured, own, optedOut, walled: configured && !optedOut };
  }

  mountHttp(mount: HttpMount): () => void {
    // Claims are evaluated once at start() validation; a mount arriving after
    // that would silently never dispatch, so refuse it loudly instead.
    // (see hasMount below for why registration order does not matter to it)
    if (this.validated) {
      throw rcError("RC5003", undefined, {
        message: `servers.${this.serverName}: mount "${mount.id}" registered after the server validated its mounts. Register mounts during plugin apply(), before context start().`,
      });
    }
    if (this.mounts.has(mount.id)) {
      throw rcError("RC5003", undefined, {
        message: `servers.${this.serverName}: duplicate mount id "${mount.id}"`,
      });
    }
    this.mounts.set(mount.id, mount);
    return () => {
      if (this.mounts.get(mount.id) !== mount) return;
      this.mounts.delete(mount.id);
      // Prune every derived structure, not only the source map: dispatch
      // routes off the evaluated snapshot, so an unmount that left it in
      // place would keep serving a surface that believes it is gone.
      this.evaluatedClaims = this.evaluatedClaims.filter(
        (entry) => entry.mount !== mount,
      );
      this.authByMount.delete(mount.id);
      this.authPolicyByMount.delete(mount.id);
    };
  }

  setBoundAddress(host: string, port: number): void {
    this.boundAddress = { host, port };
  }

  /** Mount ids registered on this server, in registration order. */
  mountIds(): readonly string[] {
    return [...this.mounts.keys()];
  }

  validate(): void {
    const evaluated = [...this.mounts.values()].map((mount) => ({
      mount,
      claims: [...mount.claims()],
    }));
    this.evaluatedClaims = evaluated;
    this.validated = true;
    this.authByMount.clear();
    this.authPolicyByMount.clear();
    for (const { mount } of evaluated) {
      const facts = this.resolveMountAuth(mount.auth);
      // The log fires only for a mount whose wall is the inherited validator.
      // An opted-out mount also resolves the server validator, but announcing
      // "inherited authentication" for a surface that opted out of walling
      // would read as the opposite of what was configured.
      const inherited = facts.walled && !facts.own;
      const auth =
        mount.auth === false || mount.auth === undefined
          ? this.serverAuth
          : mount.auth;
      this.authByMount.set(mount.id, createAuthMiddleware(auth));
      const issuer =
        auth !== undefined && "issuer" in auth
          ? (auth as { issuer?: string | string[] }).issuer
          : undefined;
      this.authPolicyByMount.set(
        mount.id,
        issuer !== undefined ? { issuer } : undefined,
      );
      if (inherited) {
        this.context.logger.info(
          { server: this.serverName, mount: mount.id },
          "Server mount inherited authentication",
        );
      }
    }
    // The `/` fallback is exempt from prefix-overlap (it is the designated
    // loser), so two mounts both claiming it would pass the pairwise check
    // and shadow each other by iteration order. Refuse that explicitly.
    const fallbackOwners = evaluated
      .filter(({ claims }) =>
        claims.some((claim) => claim.kind === "prefix" && claim.path === "/"),
      )
      .map(({ mount }) => mount.id);
    if (fallbackOwners.length > 1) {
      throw rcError("RC5003", undefined, {
        message: `servers.${this.serverName}: mounts ${fallbackOwners.map((id) => `"${id}"`).join(", ")} all claim the "/" catch-all. At most one mount per server may own the fallback.`,
      });
    }
    for (let i = 0; i < evaluated.length; i++) {
      for (let j = i + 1; j < evaluated.length; j++) {
        const left = evaluated[i]!;
        const right = evaluated[j]!;
        for (const a of left.claims) {
          for (const b of right.claims) {
            if (!claimsOverlap(a, b)) continue;
            throw rcError("RC5003", undefined, {
              message: `servers.${this.serverName}: mount "${left.mount.id}" claim ${describeClaim(a)} conflicts with mount "${right.mount.id}" claim ${describeClaim(b)}`,
            });
          }
        }
      }
    }
  }

  /**
   * Whether a mount with this id is registered here.
   *
   * Answered from the registration map rather than the evaluated snapshot, so
   * a `claims()` thunk can consult it: thunks run once every mount has
   * registered, which makes the answer independent of plugin order.
   */
  hasMount(id: string): boolean {
    return this.mounts.has(id);
  }

  async dispatch(
    request: Request,
    runtime?: import("../http/server/index.ts").HttpServerRuntime,
  ): Promise<Response> {
    const path = new URL(request.url).pathname;
    const method = request.method.toUpperCase() as HttpMethod;
    let best: { mount: HttpMount; claim: PathClaim; score: number } | undefined;
    search: for (const { mount, claims } of this.evaluatedClaims) {
      for (const claim of claims) {
        if (!methodsOf(claim).includes(method)) continue;
        const score = scoreClaim(claim, path);
        if (score === undefined) continue;
        if (best === undefined || score > best.score) {
          best = { mount, claim, score };
        }
        // An exact hit is unbeatable: validation refuses duplicate exact
        // path+method claims, so no other claim can outscore it.
        if (claim.kind === "exact") break search;
      }
    }
    if (!best) {
      return Response.json({ error: "not found", path }, { status: 404 });
    }
    const mount = best.mount;
    if (mount.longLived) runtime?.exemptFromIdleTimeout(request);
    const authMiddleware = this.authByMount.get(mount.id);

    // Verification is pulled by the mount, never pushed by the ingress: a
    // public path (discovery, health, a route with auth: "skip") must not
    // pay validator work or pollute the auth event stream just because the
    // listener is shared. Memoized so the mount and its inner dispatcher
    // resolve the same request at most once, with the events emitted at
    // that single resolution.
    let resolved: Promise<AuthResult | undefined> | undefined;
    const authenticate = (): Promise<AuthResult | undefined> => {
      resolved ??= (async () => {
        if (!authMiddleware) return undefined;
        const auth = await authMiddleware(request);
        if (auth.kind === "admit") {
          this.context.emit("auth:success", {
            subject: auth.principal.subject,
            scheme: auth.principal.scheme,
            source: mount.id,
          });
        } else if (auth.kind === "reject") {
          this.context.emit("auth:rejected", {
            reason: auth.reason,
            scheme: auth.scheme,
            source: mount.id,
          });
        }
        return auth;
      })();
      return resolved;
    };

    return mount.handler(request, {
      serverName: this.serverName,
      authenticate,
      authPolicy: this.authPolicyByMount.get(mount.id),
      auth: this.resolveMountAuth(mount.auth),
    });
  }
}

export function requireWebIngress(
  ctx: CraftContext,
  serverName = "default",
): WebIngress {
  const ingresses = ctx.getStore(WEB_INGRESSES);
  const ingress = ingresses?.get(serverName);
  if (ingress) return ingress;
  const names = ingresses ? [...ingresses.keys()] : [];
  throw rcError("RC5003", undefined, {
    message: `Server "${serverName}" is not defined. Defined servers: ${names.length > 0 ? names.join(", ") : "none"}. Configure defineConfig({ servers: { ${serverName}: { port: 8080 } } }).`,
  });
}
