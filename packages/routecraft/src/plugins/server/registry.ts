import type { CraftContext } from "../../context.ts";
import { rcError } from "../../error.ts";
import type { HttpMethod } from "../../adapters/http/types.ts";
import type { HttpMount, PathClaim, WebIngress } from "./types.ts";

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
    return false;
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
  private readonly mounts = new Map<string, HttpMount>();

  constructor(serverName: string) {
    this.serverName = serverName;
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
    for (const mount of this.mounts.values()) {
      for (const claim of mount.claims()) {
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
    return selected.mount.handler(request);
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
