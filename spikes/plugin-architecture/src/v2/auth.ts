import {
  port,
  DEFERRAL_RESUMED_BY,
  type Exchange,
  type HandlerDecision,
  type PluginContext,
  type ResumeView,
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
 * The GATE (`auth`) owns the `.authorize()` and `.resumable()` route
 * methods, the `ex.auth` facet and the handlers that enforce them, and it
 * consumes whichever authority is selected, so replacing the provider
 * replaces what the gate trusts. `.authorize()` cannot fail open: the method
 * exists only when the gate is installed, it declares {@link ENFORCEMENT},
 * the gate's own port, as a route requirement, and an ask with no grants
 * still demands an authentic principal.
 *
 * The door of a resume is two questions, as `.resume({ authorize, elevate })`
 * shipped them. `authorize` decides who may resume, over the live ingress
 * principal and the restored parked one; declared, it is the whole policy,
 * and undeclared the gate applies the route's own grants to the resumer,
 * which is recorded as the default rather than left implicit. `elevate`
 * decides what authority the continuation carries: it returns headers
 * holding a live principal that is the parked identity with at most the
 * grants the park recorded as refused lent to it; identity may not change,
 * and the answer is carried by the kernel to the run this call's claim lets
 * through and no other. A park raised at the door is re-admitted on resume,
 * so the gate that refused is asked again of what the continuation carries:
 * a lend that satisfies it passes, and without one the restored parked
 * principal is refused, which is a failure the error ring sees. The hooks are
 * bounded by the ingress signal, and false, a throw and an abort are one
 * refusal. The gate never runs on the error channel, where a restored
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
/** What the record remembers about a resumer: a reference, never a credential and never the grants. */
export interface PrincipalRef {
  readonly subject: string;
}
export interface Authority {
  /** Who these headers say the work is for, and whether that is a credential or a shape. */
  principalOf(
    headers: Readonly<Record<string, unknown>>,
  ): PrincipalView | undefined;
  /** The reference the record keeps about whoever these headers identify. */
  refOf(headers: Readonly<Record<string, unknown>>): PrincipalRef | undefined;
}
export const AUTHORITY = port<Authority>("auth.authority@3");
export interface Enforcement {
  /** The decision `.authorize(...grants)` makes over these headers; a reason when it refuses. */
  check(
    headers: Readonly<Record<string, unknown>>,
    required: readonly string[],
  ):
    | { readonly reason: string; readonly missing: readonly string[] }
    | undefined;
}
export const ENFORCEMENT = port<Enforcement>("auth.enforcement@2");
export const PRINCIPAL_HEADER = "routecraft.principal";
export const AUTHORIZE_OPTION = "auth.authorize";
export const RESUME_OPTION = "auth.resume";
/** What the door's hooks are handed: the live resumer, the restored parked identity, the raw payload, and the record without its body. */
export interface DoorInput {
  readonly principal: PrincipalView | undefined;
  readonly deferred: PrincipalView | undefined;
  readonly payload: unknown;
  readonly record: Omit<ResumeView, "headers" | "payload">;
}
export interface ResumeHooks {
  readonly authorize?: (input: DoorInput) => boolean | Promise<boolean>;
  /** Returns the headers the continuation's principal is read from: a live re-mint of the parked identity, lent at most what the park recorded as refused. */
  readonly elevate?: (
    input: DoorInput,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}
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
/** Headers carrying a freshly minted principal, for `deliver`, a resume ingress, or a door's elevation. */
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
    ctx.provide(AUTHORITY, {
      principalOf,
      refOf: (headers) => {
        const p = principalOf(headers);
        return p ? { subject: p.subject } : undefined;
      },
    });
  },
});
type AuthMethods<B, P extends readonly Plugin[], H extends object> = {
  /** Require an authentic principal holding every listed grant at admission. A route method, before `from`. */
  authorize(
    this: Cursor<B, P, H, "before">,
    ...grants: readonly string[]
  ): Chain<B, P, H, "before">;
  /** The door of a resume: who may resume, and what authority the continuation carries. */
  resumable(
    this: Cursor<B, P, H, "before">,
    hooks: ResumeHooks,
  ): Chain<B, P, H, "before">;
};
interface AuthFamily extends Family {
  readonly methods: AuthMethods<this["Body"], this["Plugins"], this["Headers"]>;
}
const facets = {
  auth: (ex: Exchange, services: ServiceLookup) => {
    const authority = services.require(AUTHORITY);
    const by = ex.headers[DEFERRAL_RESUMED_BY] as
      { auth?: { resumedBy?: PrincipalRef } } | undefined;
    return {
      principal: authority.principalOf(ex.headers),
      /** Who resumed this exchange, as the door recorded it: a reference, never a credential. */
      resumedBy: by?.auth?.resumedBy,
    };
  },
};
const survival: Survival = {
  normal: true,
  resume: true,
  debounce: true,
  errorChannel: false,
};
const grantsOf = (options: Readonly<Record<string, unknown>> | undefined) => {
  const required = options?.[AUTHORIZE_OPTION];
  return Array.isArray(required) ? (required as string[]) : undefined;
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
      resumable: (hooks: ResumeHooks) =>
        cursor
          .require(ENFORCEMENT)
          .configure({ [RESUME_OPTION]: hooks }) as Chain<B, P, H, "before">,
    };
  },
  bind(ctx: PluginContext) {
    const authority = ctx.require(AUTHORITY);
    const enforcement: Enforcement = {
      check(headers, required) {
        const p = authority.principalOf(headers);
        if (!p) return { reason: "no principal", missing: required };
        if (!p.authentic)
          return { reason: "restored principal", missing: required };
        const held = new Set([...p.grants, ...p.lent]);
        const missing = required.filter((g) => !held.has(g));
        return missing.length
          ? { reason: `missing ${missing.join(",")}`, missing }
          : undefined;
      },
    };
    ctx.provide(ENFORCEMENT, enforcement);
    const refuse = (
      reason: string,
      missing: readonly string[] = [],
    ): HandlerDecision<"admission"> => ({
      kind: "refuse",
      reason,
      detail: { refused: [...missing] },
    });
    /**
     * A hook's false, throw and failure to settle before the ingress aborts
     * are one refusal on the wire: a door whose failures can be told apart
     * from outside is an oracle for what it knows.
     */
    const settle = async <T>(
      hook: () => T | Promise<T>,
      signal: AbortSignal | undefined,
    ): Promise<{ ok: true; value: T } | { ok: false }> => {
      if (signal?.aborted) return { ok: false };
      try {
        const value = await new Promise<T>((resolve, reject) => {
          const abort = () => reject(Error("aborted"));
          signal?.addEventListener("abort", abort, { once: true });
          Promise.resolve()
            .then(hook)
            .then(resolve, reject)
            .finally(() => signal?.removeEventListener("abort", abort));
        });
        return { ok: true, value };
      } catch {
        return { ok: false };
      }
    };
    ctx.contribute({
      kind: "handler",
      id: "authorize",
      point: "admission",
      survival,
      async handle(ex, { kind, route, resume }) {
        const required = grantsOf(route.options);
        const hooks = route.options?.[RESUME_OPTION] as ResumeHooks | undefined;
        const enforce = (): HandlerDecision<"admission"> => {
          if (!required) return { kind: "allow", exchange: ex };
          const verdict = enforcement.check(ex.headers, required);
          return verdict
            ? refuse(verdict.reason, verdict.missing)
            : { kind: "allow", exchange: ex };
        };
        // A first delivery, and the re-admission of a park raised at the door: the route's gate, asked of what the exchange carries now.
        if (kind !== "resume" || !resume || resume.stage === "continuation")
          return enforce();
        const { headers, payload, signal, ...record } = resume;
        const input: DoorInput = {
          principal: authority.principalOf(ex.headers),
          deferred: authority.principalOf(headers),
          payload,
          record,
        };
        if (hooks?.authorize) {
          const verdict = await settle(() => hooks.authorize!(input), signal);
          if (!verdict.ok || verdict.value !== true)
            return refuse("door refused the resumer");
        } else if (required) {
          // Default door policy: the route's own grants, asked of the resumer. Recorded as ruling 13.
          const verdict = enforcement.check(ex.headers, required);
          if (verdict) return refuse(verdict.reason, verdict.missing);
        }
        let carry: Record<string, unknown> | undefined;
        if (hooks?.elevate) {
          const elevated = await settle(() => hooks.elevate!(input), signal);
          if (!elevated.ok) return refuse("door refused the resumer");
          const view = authority.principalOf(elevated.value);
          // The bound: what the park recorded as refused, read from this plugin's own entry, plus what the parked identity already held on loan.
          const own = resume.refusal?.["auth"] as
            { refused?: string[] } | undefined;
          const bound = new Set([
            ...(input.deferred?.lent ?? []),
            ...(own?.refused ?? []),
          ]);
          if (!view?.authentic)
            return refuse("elevation is not a live principal");
          if (
            !input.deferred ||
            view.subject !== input.deferred.subject ||
            [...view.grants].sort().join() !==
              [...input.deferred.grants].sort().join()
          )
            return refuse("elevation changes identity");
          const overreach = view.lent.filter((g) => !bound.has(g));
          if (overreach.length)
            return refuse(
              `elevation lends what was never refused: ${overreach.join(",")}`,
            );
          carry = elevated.value;
        }
        return {
          kind: "allow",
          exchange: ex,
          record: { resumedBy: authority.refOf(ex.headers) },
          ...(carry ? { carry } : {}),
        };
      },
    });
  },
};
