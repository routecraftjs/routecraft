import type {
  ActorMatcher,
  ClaimMappers,
  JwtAudience,
  OAuthPrincipal,
  Principal,
} from "./types.ts";

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

  const email = stringClaim(payload["email"]);
  if (email) principal.email = email;

  const name = stringClaim(payload["name"]);
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

  const subjectProfile = stringClaim(payload["sub_profile"]);
  if (subjectProfile !== undefined) principal.subjectProfile = subjectProfile;

  // Both delegation claims fail closed when present but unparseable (see
  // the parsers). A supplied mapper replaces the default parse ENTIRELY,
  // including its undefined results: presence-checked, not `??`-chained,
  // because a mapper that deliberately returns undefined for an
  // RFC-8693-shaped claim must not have the default parser silently
  // reinstate the actor or restriction it decided against.
  const actor = options.claims?.actor
    ? options.claims.actor(payload)
    : actorFromActClaim(payload["act"], options.kind);
  if (actor !== undefined) principal.actor = actor;

  const mayAct = options.claims?.mayAct
    ? options.claims.mayAct(payload)
    : mayActFromClaim(payload["may_act"], options.kind);
  if (mayAct !== undefined) principal.mayAct = mayAct;

  return principal;
}

/**
 * Maximum `act` nesting depth accepted from a token. RFC 8693 places no
 * bound on the chain, but the parse is recursive and the depth beyond a
 * route's `maxDelegationDepth` is never used, so an unbounded chain buys a
 * caller nothing but stack pressure. Exceeding the cap rejects the token
 * rather than truncating it: a silently shortened chain would misreport the
 * current actor.
 */
const MAX_ACT_DEPTH = 16;

/**
 * Map an RFC 8693 section 4.1 `act` claim (possibly nested) to a
 * {@link Principal} actor chain. The outermost entry is the current actor.
 *
 * **Fails closed.** RFC 8693 requires `sub` on every `act` entry. A present
 * but unparseable claim THROWS rather than resolving to `undefined`,
 * because a dropped actor is not a neutral outcome: it promotes a delegated
 * token to a direct call, which is exactly what the `authorize({ actor })`
 * default of `'none'` exists to refuse. Deployments whose IdP identifies
 * actors by a non-standard claim (for example `client_id` on a
 * client-credentials actor) map it explicitly via `ClaimMappers.actor`.
 *
 * Nested actors are plain objects at construction; the verifier boundary
 * brands and deep-freezes the chain through `markAuthentic`.
 *
 * @internal
 */
function actorFromActClaim(
  act: unknown,
  kind: "jwt" | "jwks",
  depth = 1,
): Principal | undefined {
  if (act === undefined || act === null) return undefined;
  if (depth > MAX_ACT_DEPTH) {
    throw new TypeError(
      `${kind}: verified token has an \`act\` chain deeper than ${MAX_ACT_DEPTH}. Refusing the token rather than truncating the delegation chain.`,
    );
  }
  if (typeof act !== "object" || Array.isArray(act)) {
    throw new TypeError(
      `${kind}: verified token has a non-object \`act\` claim. RFC 8693 section 4.1 requires a JSON object identifying the current actor; provide claims.actor to map a non-standard shape.`,
    );
  }
  const record = act as Record<string, unknown>;
  const subject = stringClaim(record["sub"]);
  if (subject === undefined) {
    throw new TypeError(
      `${kind}: verified token has an \`act\` claim without a \`sub\`. An actor the policy layer cannot identify must not be silently dropped, which would let a delegated token pass an actor: 'none' route; provide claims.actor to map a non-standard shape.`,
    );
  }
  const actor: Principal = { kind, scheme: "bearer", subject };
  const issuer = stringClaim(record["iss"]);
  if (issuer !== undefined) actor.issuer = issuer;
  const profile = stringClaim(record["sub_profile"]);
  if (profile !== undefined) actor.subjectProfile = profile;
  const nested = actorFromActClaim(record["act"], kind, depth + 1);
  if (nested !== undefined) actor.actor = nested;
  return actor;
}

/**
 * Map an RFC 8693 section 4.4 `may_act` claim to {@link ActorMatcher}
 * entries. The wire claim is a single JSON object naming one permitted
 * party; an array of such objects is also accepted since multi-party
 * deployments emit it in practice.
 *
 * **Fails closed**, for the same reason as {@link actorFromActClaim} and in
 * the same direction: `may_act` is a RESTRICTION, so a present-but-
 * unparseable claim must never resolve to `undefined`, which `delegate()`
 * reads as "no restriction" and would turn a narrowing claim into a
 * permissive one. Map non-standard shapes with `ClaimMappers.mayAct`.
 *
 * @internal
 */
function mayActFromClaim(
  mayAct: unknown,
  kind: "jwt" | "jwks",
): ActorMatcher[] | undefined {
  if (mayAct === undefined || mayAct === null) return undefined;
  const entries = Array.isArray(mayAct) ? mayAct : [mayAct];
  const matchers: ActorMatcher[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError(
        `${kind}: verified token has a malformed \`may_act\` entry (expected a JSON object). Refusing rather than treating a delegation restriction as absent; provide claims.mayAct to map a non-standard shape.`,
      );
    }
    const record = entry as Record<string, unknown>;
    const subject = stringClaim(record["sub"]);
    if (subject === undefined) {
      throw new TypeError(
        `${kind}: verified token has a \`may_act\` entry without a \`sub\`. Refusing rather than treating a delegation restriction as absent; provide claims.mayAct to map a non-standard shape.`,
      );
    }
    const matcher: ActorMatcher = { subject };
    const issuer = stringClaim(record["iss"]);
    if (issuer !== undefined) matcher.issuer = issuer;
    // Carry the narrowing constraints the wire claim expressed. Dropping
    // them would widen the matcher relative to what the token stated.
    const profile = stringClaim(record["sub_profile"]);
    if (profile !== undefined) matcher.profile = profile;
    const roles = Array.isArray(record["roles"])
      ? (record["roles"] as unknown[]).filter(
          (r): r is string => typeof r === "string",
        )
      : undefined;
    if (roles !== undefined && roles.length > 0) matcher.roles = roles;
    matchers.push(matcher);
  }
  return matchers.length > 0 ? matchers : undefined;
}
