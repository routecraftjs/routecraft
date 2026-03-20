import { createHmac, createVerify, timingSafeEqual } from "node:crypto";
import type { AuthPrincipal, McpHttpAuthOptions } from "./types.ts";

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
}

/**
 * RSA (asymmetric) JWT options.
 * Uses a public key to verify signatures. Only the public key is needed
 * since the server only verifies, never signs.
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
}

/**
 * Options for the built-in JWT auth helper.
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
 * Check `exp` and `nbf` temporal claims.
 * Returns `true` if the token is within valid time bounds.
 */
function checkTemporalClaims(
  payload: Record<string, unknown>,
  clockToleranceSec: number,
): boolean {
  const now = Math.floor(Date.now() / 1000);

  if (typeof payload["exp"] === "number") {
    if (now > payload["exp"] + clockToleranceSec) return false;
  }
  if (typeof payload["nbf"] === "number") {
    if (now < payload["nbf"] - clockToleranceSec) return false;
  }
  return true;
}

/**
 * Build an {@link AuthPrincipal} from standard JWT claims.
 * Returns `null` if the `sub` claim is missing or empty.
 */
function buildPrincipal(
  payload: Record<string, unknown>,
): AuthPrincipal | null {
  const sub = payload["sub"];
  if (typeof sub !== "string" || sub.length === 0) return null;

  const principal: AuthPrincipal = {
    subject: sub,
    scheme: "bearer",
    claims: payload,
  };

  if (typeof payload["iss"] === "string") principal.issuer = payload["iss"];
  if (typeof payload["exp"] === "number") principal.expiresAt = payload["exp"];
  if (typeof payload["email"] === "string") principal.email = payload["email"];
  if (typeof payload["name"] === "string") principal.name = payload["name"];

  const aud = payload["aud"];
  if (Array.isArray(aud)) principal.audience = aud as string[];
  else if (typeof aud === "string") principal.audience = [aud];

  const scope = payload["scope"];
  if (typeof scope === "string")
    principal.scopes = scope.split(" ").filter(Boolean);

  if (Array.isArray(payload["roles"]))
    principal.roles = payload["roles"] as string[];

  return principal;
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
): (token: string) => AuthPrincipal | null {
  const { secret, algorithm = "HS256", clockToleranceSec = 0 } = options;

  if (!secret || typeof secret !== "string") {
    throw new TypeError("jwt: secret must be a non-empty string");
  }
  if (!(algorithm in HMAC_ALGORITHMS)) {
    throw new TypeError(
      `jwt: unsupported algorithm "${algorithm}". Supported: ${Object.keys(HMAC_ALGORITHMS).join(", ")}`,
    );
  }

  const digest = HMAC_ALGORITHMS[algorithm];

  return (token: string): AuthPrincipal | null => {
    const decoded = decodeToken(token);
    if (!decoded) return null;

    const { headerB64, payloadB64, signatureB64, header, payload } = decoded;

    if (header["alg"] !== algorithm) return null;

    const hmac = createHmac(digest, secret);
    hmac.update(`${headerB64}.${payloadB64}`);
    const expectedSig = hmac.digest("base64url");

    const expectedBuf = Buffer.from(expectedSig);
    const actualBuf = Buffer.from(signatureB64);
    if (
      expectedBuf.length !== actualBuf.length ||
      !timingSafeEqual(expectedBuf, actualBuf)
    ) {
      return null;
    }

    if (!checkTemporalClaims(payload, clockToleranceSec)) return null;
    return buildPrincipal(payload);
  };
}

/**
 * Create an RSA signature verifier.
 */
function createRsaValidator(
  options: JwtRsaOptions,
): (token: string) => AuthPrincipal | null {
  const { publicKey, algorithm = "RS256", clockToleranceSec = 0 } = options;

  if (!publicKey || typeof publicKey !== "string") {
    throw new TypeError("jwt: publicKey must be a non-empty PEM string");
  }
  if (!(algorithm in RSA_ALGORITHMS)) {
    throw new TypeError(
      `jwt: unsupported algorithm "${algorithm}". Supported: ${Object.keys(RSA_ALGORITHMS).join(", ")}`,
    );
  }

  const verifyAlgorithm = RSA_ALGORITHMS[algorithm];

  return (token: string): AuthPrincipal | null => {
    const decoded = decodeToken(token);
    if (!decoded) return null;

    const { headerB64, payloadB64, signatureB64, header, payload } = decoded;

    if (header["alg"] !== algorithm) return null;

    const verifier = createVerify(verifyAlgorithm);
    verifier.update(`${headerB64}.${payloadB64}`);

    if (!verifier.verify(publicKey, signatureB64, "base64url")) {
      return null;
    }

    if (!checkTemporalClaims(payload, clockToleranceSec)) return null;
    return buildPrincipal(payload);
  };
}

/**
 * Built-in JWT authentication helper for MCP HTTP servers.
 * Verifies HMAC or RSA signed JWTs using only `node:crypto` (no external
 * dependencies).
 *
 * Returns an {@link McpHttpAuthOptions} that can be passed directly to
 * `mcpPlugin({ auth: jwt({ ... }) })`.
 *
 * On success the validator returns an {@link AuthPrincipal} populated from
 * standard JWT claims (`sub`, `iss`, `aud`, `exp`, `scope`, etc.) with the
 * full decoded payload available in `claims`.
 *
 * @example
 * ```ts
 * import { mcpPlugin, jwt } from "@routecraft/ai";
 *
 * // HMAC (symmetric) - shared secret
 * mcpPlugin({
 *   transport: "http",
 *   auth: jwt({ secret: process.env.JWT_SECRET! }),
 * });
 *
 * // RSA (asymmetric) - public key only
 * mcpPlugin({
 *   transport: "http",
 *   auth: jwt({ algorithm: "RS256", publicKey: process.env.JWT_PUBLIC_KEY! }),
 * });
 * ```
 *
 * @experimental
 */
export function jwt(options: JwtAuthOptions): McpHttpAuthOptions {
  const validator = isHmac(options)
    ? createHmacValidator(options)
    : createRsaValidator(options);

  return { validator };
}
