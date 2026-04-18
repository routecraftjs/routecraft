import type { ClaimMappers, JwtAudience, OAuthPrincipal } from "./types.ts";

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isNonEmpty(value: string | string[] | undefined): boolean {
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value))
    return (
      value.length > 0 &&
      value.every((v) => typeof v === "string" && v.length > 0)
    );
  return false;
}

/**
 * Assert that `issuer` is supplied and `audience` is either a non-empty value
 * or the `"*"` sentinel. Shared by `jwt()` and `jwks()` so the error wording
 * and the exact validation shape stay in sync.
 *
 * @internal
 */
export function assertIssuerAudience(
  kind: "jwt" | "jwks",
  issuer: string | string[] | undefined,
  audience: JwtAudience | undefined,
): void {
  if (!isNonEmpty(issuer)) {
    throw new TypeError(
      `${kind}: \`issuer\` is required. Set it to the expected \`iss\` claim value(s) to prevent cross-issuer token replay.`,
    );
  }
  if (audience === undefined || audience === null) {
    throw new TypeError(
      `${kind}: \`audience\` is required. Set it to the expected \`aud\` value(s), or pass "*" to skip audience validation (cross-audience replay risk).`,
    );
  }
  if (audience === "*") return;
  if (!isNonEmpty(audience)) {
    throw new TypeError(
      `${kind}: \`audience\` must be a non-empty string or array, or "*" to skip the check.`,
    );
  }
}

/**
 * Map a verified JWT payload to an {@link OAuthPrincipal}.
 *
 * Subject fallback order: `claims.subject(payload)` -> `sub` -> `client_id`
 * -> `azp`. This supports client-credentials tokens (often no `sub`) and IdPs
 * that emit only `azp`.
 *
 * Callers must ensure `exp` is already verified (jwt() enforces it before
 * calling; jwks() passes `requiredClaims: ["exp"]` to `jose.jwtVerify`). This
 * function throws if `exp` is missing, upholding the {@link OAuthPrincipal}
 * contract at the boundary.
 *
 * Package-internal helper shared between `jwt.ts` and `jwks.ts`. Never
 * re-exported from `packages/routecraft/src/index.ts`; do not import from
 * outside `src/auth/`.
 *
 * @internal
 */
export function principalFromJwtPayload(
  payload: Record<string, unknown>,
  options: { kind: "jwt" | "jwks"; claims?: ClaimMappers },
): OAuthPrincipal {
  const sub = stringClaim(payload["sub"]);
  const payloadClientId = stringClaim(payload["client_id"]);
  const azp = stringClaim(payload["azp"]);

  const subject =
    options.claims?.subject?.(payload) ?? sub ?? payloadClientId ?? azp;
  if (typeof subject !== "string" || subject.length === 0) {
    throw new TypeError(
      `${options.kind}: verified token has no subject. Expected \`sub\`, \`client_id\`, or \`azp\`; provide claims.subject to map from a non-standard field.`,
    );
  }

  const payloadClientIdOrAzp = payloadClientId ?? azp;
  const clientIdValue =
    options.claims?.clientId?.(payload) ?? payloadClientIdOrAzp;

  const audienceRaw = payload["aud"];
  const audience = Array.isArray(audienceRaw)
    ? audienceRaw.filter((a): a is string => typeof a === "string")
    : typeof audienceRaw === "string"
      ? [audienceRaw]
      : undefined;

  if (typeof payload["exp"] !== "number") {
    throw new TypeError(
      `${options.kind}: verified token has no \`exp\` claim. Tokens composed into OAuth / MCP bearer flows must carry an expiry.`,
    );
  }

  const principal: OAuthPrincipal = {
    kind: options.kind,
    scheme: "bearer",
    subject,
    expiresAt: payload["exp"],
    claims: payload,
  };

  if (clientIdValue !== undefined) principal.clientId = clientIdValue;

  const email =
    options.claims?.email?.(payload) ?? stringClaim(payload["email"]);
  if (email) principal.email = email;

  const name = options.claims?.name?.(payload) ?? stringClaim(payload["name"]);
  if (name) principal.name = name;

  if (typeof payload["iss"] === "string") principal.issuer = payload["iss"];
  if (audience !== undefined) principal.audience = audience;

  const scopes =
    options.claims?.scopes?.(payload) ??
    (typeof payload["scope"] === "string"
      ? (payload["scope"] as string).split(" ").filter(Boolean)
      : undefined);
  if (scopes !== undefined) principal.scopes = scopes;

  const roles =
    options.claims?.roles?.(payload) ??
    (Array.isArray(payload["roles"])
      ? (payload["roles"] as unknown[]).filter(
          (r): r is string => typeof r === "string",
        )
      : undefined);
  if (roles !== undefined) principal.roles = roles;

  return principal;
}
