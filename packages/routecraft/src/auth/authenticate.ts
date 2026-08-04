import { rcError } from "../error.ts";
import { markAuthentic } from "./authentic.ts";
import { type Principal } from "./types.ts";

/**
 * Identity claims accepted by {@link authenticate}. Derived from
 * {@link Principal} so the two never drift: `kind` and `scheme` are optional
 * (they default), every other `Principal` field is carried through, and
 * `subject` stays required because every minted identity must name who it
 * represents.
 */
export type PrincipalClaims = Partial<Pick<Principal, "kind" | "scheme">> &
  Omit<Principal, "kind" | "scheme" | "actor" | "grantId">;

/**
 * Mint an authenticated {@link Principal} from identity claims you have
 * already verified yourself.
 *
 * This is the explicit, greppable way to establish identity from a source
 * the framework cannot verify on its own: an inbound e-mail whose sender you
 * validated, a Slack event signature you checked, a webhook HMAC, and so on.
 * The returned principal is branded as authentic (see `markAuthentic`) and
 * frozen, so `authorize()` trusts it. A plain object written onto
 * `headers["routecraft.auth.principal"]` is NOT trusted: minting must be a
 * deliberate call, not an incidental header write.
 *
 * Inside a route, prefer the `.authenticate()` builder operation, which is
 * sugar over this helper. Use this function directly in tests, in custom
 * source adapters, or inside a `.process()` / `.choice()` branch where the
 * builder step does not fit.
 *
 * @throws RC5024 when `subject` is missing or empty.
 *
 * @example Mid-pipeline / custom source
 * ```ts
 * import { authenticate } from "@routecraft/routecraft";
 *
 * const principal = authenticate({
 *   scheme: "email",
 *   subject: sender.address,
 *   roles: sender.address.endsWith("@acme.com") ? ["internal"] : [],
 * });
 * ```
 */
export function authenticate(claims: PrincipalClaims): Principal {
  if (typeof claims?.subject !== "string" || claims.subject.length === 0) {
    throw rcError("RC5024", new Error("Principal has no subject"), {
      message: "authenticate() requires a non-empty `subject`",
      suggestion:
        "Pass the stable identity of the caller you verified, e.g. authenticate({ subject: sender.address, roles: [...] }).",
    });
  }

  // Delegation state is `delegate()`'s to establish, never a mint's. The
  // type excludes `actor` / `grantId`, and this guard closes the runtime
  // hole: without it, spreading an existing principal into authenticate()
  // would produce an authentic DELEGATED identity while skipping every
  // invariant delegate() enforces (mayAct consent, scope intersection,
  // truthful chain nesting). `mayAct` is deliberately still accepted: it
  // describes the subject (who may act FOR them), like roles, and is
  // legitimately established when identity is minted.
  const withDelegation = claims as Partial<Principal>;
  if (
    withDelegation.actor !== undefined ||
    withDelegation.grantId !== undefined
  ) {
    throw rcError(
      "RC5024",
      new Error("Delegation state passed to authenticate()"),
      {
        message:
          "authenticate() does not accept `actor` or `grantId`: minting establishes identity, delegation establishes who is acting for it",
        suggestion:
          "Mint the subject with authenticate(), then hand it to delegate(subject, actorClaims, { scopes, grantId }). Spreading a delegated principal back through authenticate() would bypass the mayAct consent check and the scope intersection.",
      },
    );
  }

  const principal: Principal = {
    ...claims,
    kind: claims.kind ?? "custom",
    scheme: claims.scheme ?? "custom",
  };

  return markAuthentic(principal);
}
