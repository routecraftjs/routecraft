import { rcCodeOf } from "./brand.ts";
import type { RoutecraftError } from "./error.ts";
import { HeadersKeys, type Exchange } from "./exchange.ts";
import type { Principal } from "./principal.ts";

/**
 * Machine-readable detail attached to an `RC5038` error's cause, naming
 * exactly what the principal lacked. Read it with `insufficientAuthorityOf`
 * to drive a consent flow:
 *
 * ```ts
 * const missing = insufficientAuthorityOf(err)
 * if (missing?.mode === "any") offerChoice(missing.scopes)
 * else if (missing?.scopes) requestGrant(missing.scopes)
 * ```
 *
 * Carries the scopes the principal lacked for a `scopes` refusal, and the
 * whole accepted set for an `anyScope` one, where any single entry would
 * have opened the door.
 *
 * In-process only: `RoutecraftError.toJSON()` serialises the cause's message
 * and stack, not its own properties, so a consumer reading the failure from
 * a serialised event log sees the scope names in the message text but not
 * this structured field.
 */
export interface InsufficientAuthority extends Error {
  missing: {
    /**
     * Readonly because {@link insufficientAuthorityOf} freezes what it
     * returns: the detail becomes a parked deferral's lend bound, and a
     * mutable one could be widened after the bound was recorded.
     */
    readonly scopes: readonly string[];
    /**
     * How to read `scopes`. `"all"` lists the required scopes the
     * principal lacked, every one of them needed. `"any"` lists the whole
     * accepted set of an `anyScope` check, of which ONE suffices, so a
     * consent flow can offer the choice rather than requesting all of them.
     *
     * Optional because an application throwing this shape itself (the
     * documented workaround before `anyScope` existed) predates the field;
     * `authorize()` always sets it. Absent means `"all"`.
     */
    mode?: "all" | "any";
    /**
     * Whether the gate that refused read the EFFECTIVE ring: the subject's
     * scopes widened by the outermost actor's.
     *
     * What it answers is whether lending a scope to the actor could ever
     * satisfy this gate. A scope check reads the subject's ring alone unless
     * the gate opts in with `effective: true` (see {@link grantedScopes} and
     * `.standards/security.md` §12), so a consent flow that would lend on the
     * ACTOR's ring can only help here when this is true; against a
     * subject-ring-only gate the refusal stands however much the actor is
     * lent, and the flow should decline rather than ask a human for a scope
     * that cannot open the door.
     *
     * Optional for the same reason as `mode`: an application throwing this
     * shape itself predates the field. `authorize()` always sets it.
     */
    effective?: boolean;
  };
}

/**
 * Refusals raised by an {@link authorize} check, keyed to the id of the
 * route whose exchange was refused.
 *
 * A module-private `WeakMap` rather than a property brand, for the reason
 * `authentic.ts` gives: membership cannot be enumerated, read back, or
 * copied onto another object. The codes `authorize()` throws are shared
 * with adapters that raise them for upstream or operator faults (an IMAP
 * login refused, a delegation misconfigured), so the code alone cannot say
 * whether the caller was refused. Only the origin can, and a copyable brand
 * would let any step dress its own failure up as the caller's.
 *
 * The route id and the refused principal ride along because a refusal
 * can be about someone other than the caller. A route calling another
 * through `direct()` receives the callee's refusal as its own step failure,
 * and a pipeline that swaps in an identity of its own (`.authenticate()`, a
 * delegation) and then checks it refused the instance, not the caller.
 */
interface RefusalOrigin {
  routeId: string | undefined;
  principal: Principal | undefined;
  /**
   * The scope detail as the gate raised it, for an `RC5038`. Read in place
   * of the error's public cause, which whoever holds the error can replace
   * or widen before rethrowing; the door and the deferral record read this.
   */
  missing: InsufficientAuthority["missing"] | undefined;
}

const refusals = new WeakMap<object, RefusalOrigin>();

/**
 * Bind an authorization refusal to the exchange it refuses, so a door
 * answers the caller (401, 403, a tool error) instead of reporting a server
 * fault. The route and the principal are read from the exchange at the
 * raise site and kept apart from the error's public fields, so a handler
 * that rethrows or widens the error cannot move the refusal onto another
 * route or caller. The shipped gate binds every refusal it raises this way;
 * an `ENFORCEMENT` replacement that raises its own binds them the same way,
 * or composes `enforcementProvider`.
 *
 * @param exchange - The exchange the gate ran on
 * @param error - The refusal, carrying one of the authorization codes
 * @returns The same error, bound
 */
export function refusal(
  exchange: Exchange<unknown>,
  error: RoutecraftError,
): RoutecraftError {
  // The validator is public and callable on a hand-built exchange-like
  // object, which may carry no headers at all.
  const headers = exchange.headers as Exchange["headers"] | undefined;
  const routeId = headers?.[HeadersKeys.ROUTE_ID];
  refusals.set(error, {
    routeId: typeof routeId === "string" ? routeId : undefined,
    principal: headers?.[HeadersKeys.AUTH_PRINCIPAL] as Principal | undefined,
    missing:
      rcCodeOf(error) === "RC5038"
        ? missingOf((error as { cause?: unknown }).cause)
        : undefined,
  });
  return error;
}

/**
 * Whether `error` is a refusal raised by an {@link authorize} check, as
 * opposed to the same code thrown by anything else.
 *
 * Doors use this to answer a refusal with a client status (401 / 403)
 * while an adapter's `RC5012` for a rejected upstream login stays a server
 * fault. With `caller`, only a refusal of that caller counts: raised on an
 * exchange of the route the door dispatched, about the very principal the
 * door admitted (compared by reference, the way identity is carried per
 * hop). A refusal raised further down the call chain, or of an identity the
 * pipeline substituted, is the instance's fault and does not match.
 *
 * @param error - Any thrown value
 * @param caller - The route the door dispatched and the principal it
 *   admitted (`undefined` when it admitted none)
 * @returns `true` when `authorize()` raised this exact error object, for
 *   `caller` when given
 */
export function isAuthorizationRefusal(
  error: unknown,
  caller?: { routeId: string; principal: Principal | undefined },
): error is RoutecraftError {
  if (typeof error !== "object" || error === null) return false;
  const origin = refusals.get(error);
  if (origin === undefined) return false;
  return (
    caller === undefined ||
    (origin.routeId === caller.routeId && origin.principal === caller.principal)
  );
}

/**
 * Read the {@link InsufficientAuthority} detail off a thrown value, or
 * `undefined` when it is not a scope refusal.
 *
 * The detail rides the CAUSE of an `RC5038`, which every consumer would
 * otherwise cast for itself. Shipped because the framework reads it too: an
 * error-path park records the refused scopes on the deferral so a resume
 * door cannot lend wider than the gate asked for, and it must read them the
 * same way an application's handler does, or the bound and the ask could
 * describe different sets.
 *
 * For a refusal `authorize()` raised, the detail is the one the gate bound
 * to the error at the throw, so a handler that widens or replaces the
 * public cause before rethrowing changes neither the bound nor what a door
 * sends. A hand-thrown `RC5038` is read off its cause.
 *
 * @param error - Anything thrown; a non-error and a non-`RC5038` both answer
 *   `undefined`
 * @returns The refusal detail, or `undefined`
 *
 * @example
 * ```ts
 * const refusal = insufficientAuthorityOf(error);
 * if (refusal?.mode === "any") offerChoice(refusal.scopes);
 * ```
 */
export function insufficientAuthorityOf(
  error: unknown,
): InsufficientAuthority["missing"] | undefined {
  // By brand: a remote payload shaped like a refusal must not name a lend bound.
  if (rcCodeOf(error) !== "RC5038") return undefined;
  const origin = refusals.get(error as object);
  if (origin !== undefined) return origin.missing;
  return missingOf((error as { cause?: unknown }).cause);
}

/** The detail a cause carries, as a frozen copy, or `undefined` for any other shape. */
function missingOf(
  cause: unknown,
): InsufficientAuthority["missing"] | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const missing = (cause as Partial<InsufficientAuthority>).missing;
  if (typeof missing !== "object" || missing === null) return undefined;
  // A hand-thrown cause of the wrong shape reads as absent, never as an empty bound.
  if (!Array.isArray(missing.scopes)) return undefined;
  if (!missing.scopes.every((scope) => typeof scope === "string")) {
    return undefined;
  }
  // A bad optional field refuses the whole detail: both drive what a consent flow asks for.
  if (
    missing.mode !== undefined &&
    missing.mode !== "all" &&
    missing.mode !== "any"
  ) {
    return undefined;
  }
  if (
    missing.effective !== undefined &&
    typeof missing.effective !== "boolean"
  ) {
    return undefined;
  }
  // A frozen copy, so what the framework records as a deferral's lend bound
  // cannot be widened afterwards by whoever still holds the error.
  return Object.freeze({
    scopes: Object.freeze([...missing.scopes]),
    ...(missing.mode !== undefined ? { mode: missing.mode } : {}),
    ...(missing.effective !== undefined
      ? { effective: missing.effective }
      : {}),
  });
}
