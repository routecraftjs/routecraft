import {
  port,
  Fault,
  allRuns,
  type Exchange,
  type PluginContext,
} from "./contracts.ts";
import { infrastructure, type Plugin } from "./dsl.ts";

/**
 * Identity as a plugin, in the direction the security standard requires.
 *
 * Core carries opaque headers. This plugin owns one header key, an
 * authenticity brand, and the `authorize` handler. The brand is `WeakSet`
 * membership over the exact object this plugin minted, which nothing else can
 * forge: a step that writes its own principal into the header produces an
 * object the set has never seen, and a principal that came back from storage
 * is a fresh parse the set has never seen either. Both are RESTORED, never
 * authentic, and `authorize` refuses them. A resumed continuation is therefore
 * authorised by whatever identity the resume ingress carries, never by the
 * one that was parked.
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
export const AUTHORIZE_OPTION = "authorize";
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
const facets = {
  principal: (ex: Exchange) => principalOf(ex),
};
/**
 * A route opts in with `options.authorize: string[]`. The entry handler refuses
 * unless the exchange carries an authentic principal holding every listed
 * grant. Survival is every run kind on purpose: a resumed continuation is
 * authorised at its ingress like any other delivery.
 */
export const auth: Plugin<import("./dsl.ts").Family, typeof facets> =
  infrastructure({
    id: "routecraft.auth",
    provides: [AUTHORITY],
    facets,
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
  });
export { Fault as AuthFault };
