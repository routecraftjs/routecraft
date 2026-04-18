import { createHmac, createVerify, timingSafeEqual } from "node:crypto";
import type {
  ClaimMappers,
  JwtAudience,
  OAuthPrincipal,
  OAuthValidatorAuthOptions,
} from "./types.ts";
import { assertIssuerAudience, principalFromJwtPayload } from "./jwt-utils.ts";

/**
 * Supported HMAC algorithms for JWT signature verification.
 * Maps JWT `alg` header values to Node.js `crypto.createHmac` digest names.
 */
const HMAC_ALGORITHMS = {
  HS256: "sha256",
  HS384: "sha384",
  HS512: "sha512",
} as const;

/**
 * Supported RSA algorithms for JWT signature verification.
 * Maps JWT `alg` header values to Node.js `crypto.createVerify` algorithm names.
 */
const RSA_ALGORITHMS = {
  RS256: "RSA-SHA256",
  RS384: "RSA-SHA384",
  RS512: "RSA-SHA512",
} as const;

type HmacAlgorithm = keyof typeof HMAC_ALGORITHMS;
type RsaAlgorithm = keyof typeof RSA_ALGORITHMS;

/**
 * HMAC (symmetric) JWT options.
 * Uses a shared secret to sign and verify tokens.
 *
 * @experimental
 */
export interface JwtHmacOptions {
  /** Shared secret used to verify HMAC signatures. */
  secret: string;
  /**
   * HMAC algorithm to accept. Default: `"HS256"`.
   * The helper rejects tokens whose `alg` header does not match.
   */
  algorithm?: HmacAlgorithm;
  /**
   * Clock skew tolerance in seconds for `exp` and `nbf` checks.
   * Default: `0` (no tolerance).
   */
  clockToleranceSec?: number;
  /**
   * Expected `iss` claim. Tokens whose `iss` does not match are rejected.
   * Required to prevent cross-issuer token replay.
   */
  issuer: string | string[];
  /**
   * Expected `aud` claim. Pass `"*"` to explicitly skip audience validation
   * (cross-audience token replay becomes possible -- use only when the IdP
   * does not emit `aud`, e.g. Clerk with no API audience configured).
   * Required to prevent cross-audience token replay.
   */
  audience: JwtAudience;
  /** Optional per-claim overrides for non-standard IdPs. */
  claims?: ClaimMappers;
}

/**
 * RSA (asymmetric) JWT options.
 * Uses a public key to verify signatures.
 *
 * @experimental
 */
export interface JwtRsaOptions {
  /** PEM-encoded public key or certificate used to verify RSA signatures. */
  publicKey: string;
  /**
   * RSA algorithm to accept. Default: `"RS256"`.
   * The helper rejects tokens whose `alg` header does not match.
   */
  algorithm?: RsaAlgorithm;
  /**
   * Clock skew tolerance in seconds for `exp` and `nbf` checks.
   * Default: `0` (no tolerance).
   */
  clockToleranceSec?: number;
  /**
   * Expected `iss` claim. Tokens whose `iss` does not match are rejected.
   * Required to prevent cross-issuer token replay.
   */
  issuer: string | string[];
  /**
   * Expected `aud` claim. Pass `"*"` to explicitly skip audience validation
   * (cross-audience token replay becomes possible -- use only when the IdP
   * does not emit `aud`, e.g. Clerk with no API audience configured).
   * Required to prevent cross-audience token replay.
   */
  audience: JwtAudience;
  /** Optional per-claim overrides for non-standard IdPs. */
  claims?: ClaimMappers;
}

/**
 * Options for the built-in static-key JWT auth helper.
 * Supports HMAC (symmetric) and RSA (asymmetric) signing.
 *
 * Discriminated by key: pass `secret` for HMAC, `publicKey` for RSA.
 *
 * @experimental
 */
export type JwtAuthOptions = JwtHmacOptions | JwtRsaOptions;

/**
 * Decode and parse the JWT header and payload segments.
 * Returns `null` if the token is malformed or not valid JSON.
 */
function decodeToken(token: string): {
  headerB64: string;
  payloadB64: string;
  signatureB64: string;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
} | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;

  try {
    const header = JSON.parse(
      Buffer.from(headerB64, "base64url").toString(),
    ) as Record<string, unknown>;
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString(),
    ) as Record<string, unknown>;
    return { headerB64, payloadB64, signatureB64, header, payload };
  } catch {
    return null;
  }
}

/**
 * Check `exp` and `nbf` temporal claims. Tokens without an `exp` claim are
 * rejected unconditionally: every token verified by `jwt()` feeds into flows
 * that require a bearer-token expiry (see {@link OAuthPrincipal}).
 */
function checkTemporalClaims(
  payload: Record<string, unknown>,
  clockToleranceSec: number,
): boolean {
  const now = Math.floor(Date.now() / 1000);

  if (typeof payload["exp"] !== "number") return false;
  if (now > payload["exp"] + clockToleranceSec) return false;

  if (typeof payload["nbf"] === "number") {
    if (now < payload["nbf"] - clockToleranceSec) return false;
  }
  return true;
}

/**
 * Validate the `iss` and `aud` claims against expected values.
 * When `expectedAudience` is `"*"` the audience check is skipped entirely.
 */
function validateIssuerAudience(
  payload: Record<string, unknown>,
  expectedIssuer: string | string[],
  expectedAudience: JwtAudience,
): boolean {
  if (typeof payload["iss"] !== "string") return false;
  const allowedIssuers = Array.isArray(expectedIssuer)
    ? expectedIssuer
    : [expectedIssuer];
  if (!allowedIssuers.includes(payload["iss"])) return false;

  if (expectedAudience === "*") return true;

  const allowedAudiences = Array.isArray(expectedAudience)
    ? expectedAudience
    : [expectedAudience];
  const aud = payload["aud"];
  const tokenAud = Array.isArray(aud)
    ? aud.filter((a): a is string => typeof a === "string")
    : typeof aud === "string"
      ? [aud]
      : [];
  if (!tokenAud.some((a) => allowedAudiences.includes(a))) return false;

  return true;
}

/** Type guard: options contain `secret` (HMAC). */
function isHmac(options: JwtAuthOptions): options is JwtHmacOptions {
  return "secret" in options;
}

/**
 * Create an HMAC signature verifier.
 */
function createHmacValidator(
  options: JwtHmacOptions,
): (token: string) => Promise<OAuthPrincipal> {
  const {
    secret,
    algorithm = "HS256",
    clockToleranceSec = 0,
    issuer,
    audience,
    claims,
  } = options;

  if (!secret || typeof secret !== "string") {
    throw new TypeError("jwt: secret must be a non-empty string");
  }
  if (!(algorithm in HMAC_ALGORITHMS)) {
    throw new TypeError(
      `jwt: unsupported algorithm "${algorithm}". Supported: ${Object.keys(HMAC_ALGORITHMS).join(", ")}`,
    );
  }

  const digest = HMAC_ALGORITHMS[algorithm];

  return async (token: string): Promise<OAuthPrincipal> => {
    const decoded = decodeToken(token);
    if (!decoded) throw new Error("jwt: malformed token");

    const { headerB64, payloadB64, signatureB64, header, payload } = decoded;

    if (header["alg"] !== algorithm)
      throw new Error(`jwt: unexpected algorithm "${String(header["alg"])}"`);

    const hmac = createHmac(digest, secret);
    hmac.update(`${headerB64}.${payloadB64}`);
    const expectedSig = hmac.digest("base64url");

    const expectedBuf = Buffer.from(expectedSig);
    const actualBuf = Buffer.from(signatureB64);
    if (
      expectedBuf.length !== actualBuf.length ||
      !timingSafeEqual(expectedBuf, actualBuf)
    ) {
      throw new Error("jwt: invalid signature");
    }

    if (!checkTemporalClaims(payload, clockToleranceSec))
      throw new Error("jwt: token expired or not yet valid");
    if (!validateIssuerAudience(payload, issuer, audience))
      throw new Error("jwt: invalid issuer or audience");

    return principalFromJwtPayload(payload, {
      kind: "jwt",
      ...(claims !== undefined && { claims }),
    });
  };
}

/**
 * Create an RSA signature verifier.
 */
function createRsaValidator(
  options: JwtRsaOptions,
): (token: string) => Promise<OAuthPrincipal> {
  const {
    publicKey,
    algorithm = "RS256",
    clockToleranceSec = 0,
    issuer,
    audience,
    claims,
  } = options;

  if (!publicKey || typeof publicKey !== "string") {
    throw new TypeError("jwt: publicKey must be a non-empty PEM string");
  }
  if (!(algorithm in RSA_ALGORITHMS)) {
    throw new TypeError(
      `jwt: unsupported algorithm "${algorithm}". Supported: ${Object.keys(RSA_ALGORITHMS).join(", ")}`,
    );
  }

  const verifyAlgorithm = RSA_ALGORITHMS[algorithm];

  return async (token: string): Promise<OAuthPrincipal> => {
    const decoded = decodeToken(token);
    if (!decoded) throw new Error("jwt: malformed token");

    const { headerB64, payloadB64, signatureB64, header, payload } = decoded;

    if (header["alg"] !== algorithm)
      throw new Error(`jwt: unexpected algorithm "${String(header["alg"])}"`);

    const verifier = createVerify(verifyAlgorithm);
    verifier.update(`${headerB64}.${payloadB64}`);

    if (!verifier.verify(publicKey, signatureB64, "base64url")) {
      throw new Error("jwt: invalid signature");
    }

    if (!checkTemporalClaims(payload, clockToleranceSec))
      throw new Error("jwt: token expired or not yet valid");
    if (!validateIssuerAudience(payload, issuer, audience))
      throw new Error("jwt: invalid issuer or audience");

    return principalFromJwtPayload(payload, {
      kind: "jwt",
      ...(claims !== undefined && { claims }),
    });
  };
}

/**
 * Built-in static-key JWT authentication helper.
 * Verifies HMAC or RSA signed JWTs using only `node:crypto` (no external
 * dependencies).
 *
 * Returns an {@link OAuthValidatorAuthOptions} that can be passed directly to
 * `mcpPlugin({ auth: jwt({ ... }) })` or `oauth({ verify: jwt({ ... }) })`.
 * Because the return type guarantees an {@link OAuthPrincipal}, it is also
 * structurally assignable wherever a plain `ValidatorAuthOptions` is accepted.
 *
 * On success the validator returns an {@link OAuthPrincipal} (`kind: "jwt"`)
 * populated from standard JWT claims (`sub`, `iss`, `aud`, `exp`, `scope`,
 * etc.) with the full decoded payload available in `claims`.
 *
 * Security: `issuer` is required to bind tokens to the expected IdP and prevent
 * cross-issuer replay. `audience` is required (or explicitly set to `"*"` to
 * opt out) to bind tokens to this resource and prevent cross-audience replay.
 * Tokens without an `exp` claim are always rejected.
 *
 * @example
 * ```ts
 * import { mcpPlugin, jwt } from "@routecraft/ai";
 *
 * // HMAC (symmetric): shared secret
 * mcpPlugin({
 *   transport: "http",
 *   auth: jwt({
 *     secret: process.env.JWT_SECRET!,
 *     issuer: "https://idp.example.com",
 *     audience: "https://mcp.example.com",
 *   }),
 * });
 *
 * // RSA (asymmetric): public key only
 * mcpPlugin({
 *   transport: "http",
 *   auth: jwt({
 *     algorithm: "RS256",
 *     publicKey: process.env.JWT_PUBLIC_KEY!,
 *     issuer: "https://idp.example.com",
 *     audience: "https://mcp.example.com",
 *   }),
 * });
 * ```
 *
 * @experimental
 */
export function jwt(options: JwtAuthOptions): OAuthValidatorAuthOptions {
  assertIssuerAudience("jwt", options.issuer, options.audience);
  const validator = isHmac(options)
    ? createHmacValidator(options)
    : createRsaValidator(options);

  return { validator };
}
