import {
  port,
  allRuns,
  type Exchange,
  type PluginContext,
} from "./contracts.ts";
import {
  type Plugin,
  type Family,
  type Cursor,
  type Chain,
  type Phase,
} from "./dsl.ts";

/**
 * Identity as a plugin, in the direction the security standard requires.
 *
 * Core carries opaque headers. This plugin owns one header key, an
 * authenticity brand, the `.authorize()` route method and the entry handler
 * that enforces it. The brand is `WeakSet` membership over the exact object
 * this plugin minted, which nothing else can forge: a step that writes its own
 * principal into the header produces an object the set has never seen, and a
 * principal that came back from storage is a fresh parse the set has never
 * seen either. Both are RESTORED, never authentic, and `authorize` refuses
 * them. A resumed continuation is therefore authorised by whatever identity
 * the resume ingress carries, never by the one that was parked.
 *
 * `.authorize()` cannot fail open. It is a method this plugin contributes, so
 * a route cannot express the ask without the plugin installed, and it declares
 * the {@link AUTHORITY} port as a route requirement, so the kernel refuses to
 * compile the route if the plugin is absent at runtime.
 */
export interface Principal {
  readonly subject: string;
  readonly grants: readonly string[];
  readonly lent: readonly string[];
}
export interface PrincipalView extends Principal {
  /** True only for the object this plugin minted in this process. */
  readonly authentic: boolean;
}
export const PRINCIPAL_HEADER = "routecraft.principal";
export const AUTHORIZE_OPTION = "auth.authorize";
const authentic = new WeakSet<object>();
/** Brand a principal as minted by a trusted origin. The frozen object IS the credential. */
export function mint(principal: Principal): Principal {
  const minted = Object.freeze({
    subject: principal.subject,
    grants: Object.freeze([...principal.grants]),
    lent: Object.freeze([...principal.lent]),
  });
  authentic.add(minted);
  return minted;
}
export function isAuthentic(value: unknown): value is Principal {
  return typeof value === "object" && value !== null && authentic.has(value);
}
/** Headers carrying a freshly minted principal, for `deliver` and for the resume ingress. */
export function withPrincipal(
  headers: Record<string, unknown>,
  principal: Principal,
): Record<string, unknown> {
  return { ...headers, [PRINCIPAL_HEADER]: mint(principal) };
}
export function principalOf(ex: Exchange): PrincipalView | undefined {
  const raw = ex.headers[PRINCIPAL_HEADER];
  if (typeof raw !== "object" || raw === null) return undefined;
  const p = raw as Principal;
  return {
    subject: p.subject,
    grants: p.grants ?? [],
    lent: p.lent ?? [],
    authentic: isAuthentic(raw),
  };
}
export interface Authority {
  principalOf(ex: Exchange): PrincipalView | undefined;
  /** Every grant the principal holds, whether granted or lent. Empty for a restored or missing principal. */
  effective(ex: Exchange): readonly string[];
}
export const AUTHORITY = port<Authority>("auth.authority@1");
type AuthMethods<B, P extends readonly Plugin[], H extends object> = {
  /** Require every listed grant from an authentic principal at entry. A route method, before `from`. */
  authorize(
    this: Cursor<B, P, H, "before">,
    ...grants: readonly string[]
  ): Chain<B, P, H, "before">;
};
interface AuthFamily extends Family {
  readonly methods: AuthMethods<this["Body"], this["Plugins"], this["Headers"]>;
}
const facets = {
  auth: (ex: Exchange) => ({ principal: principalOf(ex) }),
};
export const auth: Plugin<AuthFamily, typeof facets> = {
  id: "routecraft.auth",
  provides: [AUTHORITY],
  facets,
  methods<B, P extends readonly Plugin[], H extends object, S extends Phase>(
    cursor: Cursor<B, P, H, S>,
  ) {
    return {
      authorize: (...grants: readonly string[]) =>
        cursor
          .require(AUTHORITY)
          .configure({ [AUTHORIZE_OPTION]: [...grants] }) as Chain<
          B,
          P,
          H,
          "before"
        >,
    };
  },
  bind(ctx: PluginContext) {
    const authority: Authority = {
      principalOf,
      effective: (ex) => {
        const p = principalOf(ex);
        return p?.authentic ? [...p.grants, ...p.lent] : [];
      },
    };
    ctx.provide(AUTHORITY, authority);
    ctx.contribute({
      kind: "handler",
      id: "authorize",
      point: "entry",
      survival: allRuns,
      handle(ex, { route }) {
        const required = route.options?.[AUTHORIZE_OPTION];
        if (!Array.isArray(required) || required.length === 0)
          return { kind: "allow", exchange: ex };
        const p = principalOf(ex);
        if (!p) return { kind: "refuse", reason: "no principal" };
        if (!p.authentic)
          return { kind: "refuse", reason: "restored principal" };
        const held = new Set([...p.grants, ...p.lent]);
        const missing = (required as string[]).filter((g) => !held.has(g));
        return missing.length
          ? { kind: "refuse", reason: `missing ${missing.join(",")}` }
          : { kind: "allow", exchange: ex };
      },
    });
  },
};
