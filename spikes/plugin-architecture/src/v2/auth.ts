import {
  port,
  DEFERRAL_INGRESS,
  type Exchange,
  type PluginContext,
  type ServiceLookup,
  type Survival,
} from "./contracts.ts";
import {
  infrastructure,
  type Plugin,
  type Family,
  type Cursor,
  type Chain,
  type Phase,
} from "./dsl.ts";

/**
 * Identity as two plugins, in the direction the security standard requires.
 *
 * Core carries opaque headers. The PROVIDER (`principals`) owns one header
 * key and an authenticity brand: `WeakSet` membership over the exact object
 * it minted, which nothing else can forge. A step that writes its own
 * principal produces an object the set has never seen, and a principal that
 * came back from storage is a fresh parse the set has never seen either.
 * Both are RESTORED, never authentic. A vendor replaces this provider by
 * providing {@link AUTHORITY} under its own header and its own brand.
 *
 * The GATE (`auth`) owns the `.authorize()` route method, the `ex.auth`
 * facet and the admission handler that enforces the ask, and it consumes
 * whichever authority is selected, so replacing the provider replaces what
 * the gate trusts. `.authorize()` cannot fail open: the method exists only
 * when the gate is installed, and it declares {@link ENFORCEMENT}, the
 * gate's own port, as a route requirement, so a route carrying the ask
 * refuses to compile without the gate, whatever else provides authority.
 *
 * The gate runs at admission, before a resume spends its approval: a
 * refused resumer leaves the approval usable by the rightful one. It
 * authorises the ingress of a resume and never the continuation, which runs
 * as the restored principal that parked and is refused by any downstream
 * `.authorize()`; a step that needs live authority after the wait mints it
 * explicitly. It does not run on the error channel, where a restored
 * principal is the only one there is and nothing is asking to execute.
 */
export interface Principal {
  readonly subject: string;
  readonly grants: readonly string[];
  readonly lent: readonly string[];
}
export interface PrincipalView extends Principal {
  /** True only for an object the selected authority minted in this process. */
  readonly authentic: boolean;
}
export interface Authority {
  /** Who these headers say the work is for, and whether that is a credential or a shape. */
  principalOf(
    headers: Readonly<Record<string, unknown>>,
  ): PrincipalView | undefined;
}
export const AUTHORITY = port<Authority>("auth.authority@2");
export interface Enforcement {
  /** The decision `.authorize(...grants)` makes over these headers; a reason when it refuses. */
  check(
    headers: Readonly<Record<string, unknown>>,
    required: readonly string[],
  ): string | undefined;
}
export const ENFORCEMENT = port<Enforcement>("auth.enforcement@1");
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
/** Headers carrying a freshly minted principal, for `deliver`, a resume ingress, or an explicit re-mint after a wait. */
export function withPrincipal(
  headers: Record<string, unknown>,
  principal: Principal,
): Record<string, unknown> {
  return { ...headers, [PRINCIPAL_HEADER]: mint(principal) };
}
export function principalOf(
  headers: Readonly<Record<string, unknown>>,
): PrincipalView | undefined {
  const raw = headers[PRINCIPAL_HEADER];
  if (typeof raw !== "object" || raw === null) return undefined;
  const p = raw as Principal;
  return {
    subject: p.subject,
    grants: p.grants ?? [],
    lent: p.lent ?? [],
    authentic: isAuthentic(raw),
  };
}
/** The default authority: this module's header and brand. */
export const principals = infrastructure({
  id: "routecraft.principals",
  provides: [AUTHORITY],
  bind(ctx) {
    ctx.provide(AUTHORITY, { principalOf });
  },
});
type AuthMethods<B, P extends readonly Plugin[], H extends object> = {
  /** Require every listed grant from an authentic principal at admission. A route method, before `from`. */
  authorize(
    this: Cursor<B, P, H, "before">,
    ...grants: readonly string[]
  ): Chain<B, P, H, "before">;
};
interface AuthFamily extends Family {
  readonly methods: AuthMethods<this["Body"], this["Plugins"], this["Headers"]>;
}
const facets = {
  auth: (ex: Exchange, services: ServiceLookup) => {
    const authority = services.require(AUTHORITY);
    const ingress = ex.headers[DEFERRAL_INGRESS];
    return {
      principal: authority.principalOf(ex.headers),
      /** Who resumed this exchange, read off the recorded ingress: a shape, never a credential. */
      resumedBy:
        typeof ingress === "object" && ingress !== null
          ? authority.principalOf(ingress as Record<string, unknown>)
          : undefined,
    };
  },
};
const survival: Survival = {
  normal: true,
  resume: true,
  debounce: true,
  errorChannel: false,
};
export const auth: Plugin<AuthFamily, typeof facets> = {
  id: "routecraft.auth",
  requires: [AUTHORITY],
  provides: [ENFORCEMENT],
  facets,
  methods<B, P extends readonly Plugin[], H extends object, S extends Phase>(
    cursor: Cursor<B, P, H, S>,
  ) {
    return {
      authorize: (...grants: readonly string[]) =>
        cursor
          .require(ENFORCEMENT)
          .configure({ [AUTHORIZE_OPTION]: [...grants] }) as Chain<
          B,
          P,
          H,
          "before"
        >,
    };
  },
  bind(ctx: PluginContext) {
    const authority = ctx.require(AUTHORITY);
    const enforcement: Enforcement = {
      check(headers, required) {
        if (required.length === 0) return undefined;
        const p = authority.principalOf(headers);
        if (!p) return "no principal";
        if (!p.authentic) return "restored principal";
        const held = new Set([...p.grants, ...p.lent]);
        const missing = required.filter((g) => !held.has(g));
        return missing.length ? `missing ${missing.join(",")}` : undefined;
      },
    };
    ctx.provide(ENFORCEMENT, enforcement);
    ctx.contribute({
      kind: "handler",
      id: "authorize",
      point: "admission",
      survival,
      handle(ex, { route }) {
        const required = route.options?.[AUTHORIZE_OPTION];
        if (!Array.isArray(required)) return { kind: "allow", exchange: ex };
        const reason = enforcement.check(ex.headers, required as string[]);
        return reason
          ? { kind: "refuse", reason }
          : { kind: "allow", exchange: ex };
      },
    });
  },
};
