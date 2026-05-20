import { rcError } from "../error.ts";
import { markAuthentic } from "./authentic.ts";
import { type Principal } from "./types.ts";

/**
 * Identity claims accepted by {@link authenticate}. Mirrors {@link Principal}
 * but `kind` and `scheme` are optional (they default), and `subject` is
 * required: every minted identity must name who it represents.
 *
 * @experimental
 */
export interface PrincipalClaims {
  /** Stable identity for the authenticated entity. Required. */
  subject: string;
  /** How the principal was authenticated. Defaults to `"custom"`. */
  kind?: Principal["kind"];
  /** Authentication scheme. Defaults to `"custom"`. */
  scheme?: string;
  /** OAuth client ID (distinct from subject). */
  clientId?: string;
  /** Token issuer. */
  issuer?: string;
  /** Intended audiences. */
  audience?: string[];
  /** Email address. */
  email?: string;
  /** Display name. */
  name?: string;
  /** OAuth 2.0 / scopes granted to this identity. */
  scopes?: string[];
  /** Roles granted to this identity. */
  roles?: string[];
  /** Expiry as Unix epoch seconds. */
  expiresAt?: number;
  /** Arbitrary verified claims. */
  claims?: Record<string, unknown>;
  /** Raw OIDC userinfo response, when available. */
  userinfoClaims?: Record<string, unknown>;
}

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
 * @throws RC5023 when `subject` is missing or empty.
 *
 * @experimental
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
    throw rcError("RC5023", new Error("Principal has no subject"), {
      message: "authenticate() requires a non-empty `subject`",
      suggestion:
        "Pass the stable identity of the caller you verified, e.g. authenticate({ subject: sender.address, roles: [...] }).",
    });
  }

  const principal: Principal = {
    kind: claims.kind ?? "custom",
    scheme: claims.scheme ?? "custom",
    subject: claims.subject,
  };
  if (claims.clientId !== undefined) principal.clientId = claims.clientId;
  if (claims.issuer !== undefined) principal.issuer = claims.issuer;
  if (claims.audience !== undefined) principal.audience = claims.audience;
  if (claims.email !== undefined) principal.email = claims.email;
  if (claims.name !== undefined) principal.name = claims.name;
  if (claims.scopes !== undefined) principal.scopes = claims.scopes;
  if (claims.roles !== undefined) principal.roles = claims.roles;
  if (claims.expiresAt !== undefined) principal.expiresAt = claims.expiresAt;
  if (claims.claims !== undefined) principal.claims = claims.claims;
  if (claims.userinfoClaims !== undefined) {
    principal.userinfoClaims = claims.userinfoClaims;
  }

  return markAuthentic(principal);
}
