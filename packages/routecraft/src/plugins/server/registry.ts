import type { CraftContext } from "../../context.ts";
import { rcError } from "../../error.ts";
import type { HttpMethod } from "../../adapters/http/types.ts";
import type { HttpMount, PathClaim, WebIngress } from "./types.ts";
import type { ValidatorAuthOptions } from "../../auth/types.ts";
import { createAuthMiddleware, type HttpAuthMiddleware } from "../http/auth.ts";

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
    return (
      prefixContains(b.path, a.staticPrefix) ||
      prefixContains(a.staticPrefix, b.path)
    );
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

export class HttpMountRegistry implements WebIngress {
  readonly serverName: string;
  readonly serverAuthConfigured: boolean;
  boundAddress: { readonly host: string; readonly port: number } | undefined;
  private readonly mounts = new Map<string, HttpMount>();
  private readonly serverAuth: ValidatorAuthOptions | undefined;
  private readonly context: CraftContext;
  private readonly authByMount = new Map<
    string,
    HttpAuthMiddleware | undefined
  >();
  private readonly authOptionsByMount = new Map<
    string,
    Parameters<typeof createAuthMiddleware>[0]
  >();
  private evaluatedClaims: ReadonlyArray<{
    mount: HttpMount;
    claims: readonly PathClaim[];
  }> = [];

  constructor(
    serverName: string,
    context: CraftContext,
    serverAuth?: ValidatorAuthOptions,
  ) {
    this.serverName = serverName;
    this.context = context;
    this.serverAuth = serverAuth;
    this.serverAuthConfigured = serverAuth !== undefined;
  }

  mountHttp(mount: HttpMount): () => void {
    if (this.mounts.has(mount.id)) {
      throw rcError("RC5003", undefined, {
        message: `servers.${this.serverName}: duplicate mount id "${mount.id}"`,
      });
    }
    this.mounts.set(mount.id, mount);
    return () => {
      if (this.mounts.get(mount.id) === mount) this.mounts.delete(mount.id);
    };
  }

  setBoundAddress(host: string, port: number): void {
    this.boundAddress = { host, port };
  }

  validate(): void {
    if (this.mounts.size === 0) {
      throw rcError("RC5003", undefined, {
        message: `servers.${this.serverName}: server has no mounts. Remove it or bind a surface to it.`,
      });
    }
    const evaluated = [...this.mounts.values()].map((mount) => ({
      mount,
      claims: [...mount.claims()],
    }));
    this.evaluatedClaims = evaluated;
    this.authByMount.clear();
    this.authOptionsByMount.clear();
    for (const { mount } of evaluated) {
      const inherited =
        mount.auth === undefined && this.serverAuth !== undefined;
      const auth =
        mount.auth === false ? undefined : (mount.auth ?? this.serverAuth);
      this.authByMount.set(mount.id, createAuthMiddleware(auth));
      this.authOptionsByMount.set(mount.id, auth);
      if (inherited) {
        this.context.logger.info(
          { server: this.serverName, mount: mount.id },
          "Server mount inherited authentication",
        );
      }
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

  async dispatch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const method = request.method.toUpperCase() as HttpMethod;
    const candidates: Array<{
      mount: HttpMount;
      claim: PathClaim;
      score: number;
    }> = [];
    for (const { mount, claims } of this.evaluatedClaims) {
      for (const claim of claims) {
        if (!methodsOf(claim).includes(method)) continue;
        if (claim.kind === "exact" && claim.path === path) {
          candidates.push({ mount, claim, score: 1_000_000 + path.length });
        } else if (claim.kind === "pattern" && claim.matcher.match(path)) {
          candidates.push({
            mount,
            claim,
            score: 500_000 + claim.staticPrefix.length,
          });
        } else if (
          claim.kind === "prefix" &&
          prefixContains(claim.path, path)
        ) {
          candidates.push({ mount, claim, score: claim.path.length });
        }
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    const selected = candidates[0];
    if (!selected) {
      return Response.json({ error: "not found", path }, { status: 404 });
    }
    const authMiddleware = this.authByMount.get(selected.mount.id);
    const auth = authMiddleware ? await authMiddleware(request) : undefined;
    if (auth?.kind === "admit") {
      this.context.emit("auth:success", {
        subject: auth.principal.subject,
        scheme: auth.principal.scheme,
        source: selected.mount.id,
      });
    } else if (auth?.kind === "reject") {
      this.context.emit("auth:rejected", {
        reason: auth.reason,
        scheme: auth.scheme,
        source: selected.mount.id,
      });
    }
    return selected.mount.handler(request, {
      serverName: this.serverName,
      auth,
      authOptions: this.authOptionsByMount.get(selected.mount.id),
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
