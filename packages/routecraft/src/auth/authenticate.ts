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
  Omit<Principal, "kind" | "scheme">;

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

  const principal: Principal = {
    ...claims,
    kind: claims.kind ?? "custom",
    scheme: claims.scheme ?? "custom",
  };

  return markAuthentic(principal);
}
