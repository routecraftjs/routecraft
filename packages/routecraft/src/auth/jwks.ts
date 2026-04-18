import type {
  ClaimMappers,
  JwtAudience,
  OAuthValidatorAuthOptions,
} from "./types.ts";
import { assertIssuerAudience, principalFromJwtPayload } from "./jwt-utils.ts";

/**
 * Narrow subset of `jose` the JWKS verifier uses. Declared so the verifier
 * has real types even when the optional peer dependency is not resolvable at
 * compile time.
 */
interface JoseSubset {
  createRemoteJWKSet: (
    url: URL,
  ) => (header: unknown, input: unknown) => Promise<unknown>;
  jwtVerify: (
    token: string,
    key: unknown,
    options: {
      issuer?: string | string[];
      audience?: string | string[];
      algorithms?: string[];
      clockTolerance?: number;
      requiredClaims?: string[];
    },
  ) => Promise<{ payload: Record<string, unknown> }>;
}

/**
 * Default allowlist of JWS algorithms accepted by `jwks()`.
 * Asymmetric only; symmetric `HS*` algorithms are excluded because a JWKS
 * containing an `oct` key that a JWT-issuing attacker can reproduce would
 * enable algorithm-confusion attacks.
 */
const DEFAULT_JWKS_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
];

/**
 * Options for the JWKS-backed JWT auth helper.
 *
 * @experimental
 */
export interface JwksOptions {
  /**
   * JWKS endpoint URL used to fetch the IdP's signing keys.
   * Keys are cached and rotated by `jose`'s `createRemoteJWKSet`.
   */
  jwksUrl: string | URL;
  /**
   * Expected `iss` claim. Tokens whose issuer does not match are rejected,
   * preventing cross-issuer replay.
   */
  issuer: string | string[];
  /**
   * Expected `aud` claim. Pass `"*"` to explicitly skip audience validation
   * (cross-audience token replay becomes possible -- use only when the IdP
   * does not emit `aud`, e.g. Clerk with no API audience configured).
   * Required to prevent cross-audience token replay.
   */
  audience: JwtAudience;
  /**
   * Accepted JWS algorithms. Defaults to the asymmetric `RS*`/`PS*`/`ES*`/`EdDSA`
   * family. Restrict further if the IdP only uses a single algorithm; expand
   * only if the IdP uses something outside the defaults.
   */
  algorithms?: string[];
  /**
   * Clock skew tolerance in seconds applied to `exp` and `nbf` validation.
   * Passed through to `jose`'s `jwtVerify`. Default: no tolerance.
   */
  clockToleranceSec?: number;
  /** Optional per-claim overrides for non-standard IdPs. */
  claims?: ClaimMappers;
}

/**
 * JWKS-backed JWT authentication helper.
 * Verifies bearer JWTs against a remote JWKS endpoint using `jose`.
 * Keys are cached and rotated automatically. Tokens without an `exp` claim
 * are always rejected (enforced via `jose`'s `requiredClaims`).
 *
 * Returns an {@link OAuthValidatorAuthOptions} that can be passed directly to
 * `mcpPlugin({ auth: jwks({ ... }) })` or `oauth({ verify: jwks({ ... }) })`.
 * Because the return type guarantees an {@link OAuthPrincipal}, it is also
 * structurally assignable wherever a plain `ValidatorAuthOptions` is accepted.
 *
 * On success the validator returns an {@link OAuthPrincipal} (`kind: "jwks"`)
 * populated from standard JWT claims (`sub`, `iss`, `aud`, `exp`, `scope`,
 * etc.) with the full decoded payload available in `claims`.
 *
 * Requires the optional peer dependency `jose`:
 * ```sh
 * pnpm add jose
 * ```
 *
 * @example
 * ```ts
 * import { mcpPlugin, jwks } from "@routecraft/ai";
 *
 * // Standalone: just verify bearer JWTs (no OAuth proxy flow)
 * mcpPlugin({
 *   transport: "http",
 *   auth: jwks({
 *     jwksUrl: "https://idp.example.com/.well-known/jwks.json",
 *     issuer: "https://idp.example.com",
 *     audience: "https://mcp.example.com",
 *   }),
 * });
 * ```
 *
 * @experimental
 */
export function jwks(options: JwksOptions): OAuthValidatorAuthOptions {
  assertIssuerAudience("jwks", options.issuer, options.audience);

  let joseMod: JoseSubset | null = null;
  let jwkSet: ReturnType<JoseSubset["createRemoteJWKSet"]> | null = null;

  const algorithms = options.algorithms ?? DEFAULT_JWKS_ALGORITHMS;

  return {
    validator: async (token: string) => {
      if (joseMod === null) {
        try {
          joseMod = (await import("jose")) as unknown as JoseSubset;
        } catch {
          throw new Error(
            'jwks() requires the optional peer dependency "jose". Install it with: pnpm add jose',
          );
        }
      }
      if (jwkSet === null) {
        jwkSet = joseMod.createRemoteJWKSet(
          new URL(options.jwksUrl.toString()),
        );
      }

      const joseOptions: {
        issuer?: string | string[];
        audience?: string | string[];
        algorithms?: string[];
        clockTolerance?: number;
        requiredClaims?: string[];
      } = {
        issuer: options.issuer,
        algorithms,
        requiredClaims: ["exp"],
      };

      if (options.audience !== "*") {
        joseOptions.audience = options.audience as string | string[];
      }
      if (options.clockToleranceSec !== undefined) {
        joseOptions.clockTolerance = options.clockToleranceSec;
      }

      const { payload } = await joseMod.jwtVerify(token, jwkSet, joseOptions);

      return principalFromJwtPayload(payload as Record<string, unknown>, {
        kind: "jwks",
        ...(options.claims !== undefined && { claims: options.claims }),
      });
    },
  };
}
