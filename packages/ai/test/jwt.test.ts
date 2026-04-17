import { describe, test, expect } from "vitest";
import { createHmac } from "node:crypto";
import { jwt, type JwtAuthOptions } from "../src/mcp/jwt.ts";
import type { JwtPrincipal } from "../src/mcp/types.ts";

/**
 * Sign a JWT with HS256 using the test secret. Returns the full compact
 * token. Used by every test in this file to avoid pulling in a JWT library.
 */
function signHs256(
  payload: Record<string, unknown>,
  secret: string,
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): string {
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

const SECRET = "test-secret-for-hs256-at-least-32-bytes-long";
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const ISSUER = "https://idp.example.com";
const AUDIENCE = "https://mcp.example.com";

describe("jwt()", () => {
  describe("required options", () => {
    /**
     * @case Factory rejects HMAC options that omit issuer to prevent cross-issuer replay
     * @preconditions jwt({ secret }) called without issuer
     * @expectedResult Throws TypeError mentioning issuer
     */
    test("throws when issuer is omitted", () => {
      expect(() =>
        jwt({
          secret: SECRET,
          audience: AUDIENCE,
        } as unknown as JwtAuthOptions),
      ).toThrow(/issuer/);
    });

    /**
     * @case Factory rejects HMAC options that omit audience to prevent cross-audience replay
     * @preconditions jwt({ secret, issuer }) called without audience
     * @expectedResult Throws TypeError mentioning audience
     */
    test("throws when audience is omitted", () => {
      expect(() =>
        jwt({ secret: SECRET, issuer: ISSUER } as unknown as JwtAuthOptions),
      ).toThrow(/audience/);
    });

    /**
     * @case Factory rejects empty-string issuer so an unset env var cannot silently disable the check
     * @preconditions issuer is an empty string
     * @expectedResult Throws TypeError mentioning issuer
     */
    test("throws when issuer is empty", () => {
      expect(() =>
        jwt({ secret: SECRET, issuer: "", audience: AUDIENCE }),
      ).toThrow(/issuer/);
    });

    /**
     * @case Factory rejects empty-string audience so an unset env var cannot silently disable the check
     * @preconditions audience is an empty string
     * @expectedResult Throws TypeError mentioning audience
     */
    test("throws when audience is empty", () => {
      expect(() =>
        jwt({ secret: SECRET, issuer: ISSUER, audience: "" }),
      ).toThrow(/audience/);
    });
  });

  describe("issuer validation", () => {
    /**
     * @case Token with matching iss is accepted when issuer is set as a string
     * @preconditions jwt() configured with issuer and audience; token carries both claims matching
     * @expectedResult Validator returns a JwtPrincipal with subject from sub
     */
    test("accepts matching iss when issuer is a single string", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        {
          sub: "user-1",
          iss: ISSUER,
          aud: AUDIENCE,
          exp: FUTURE,
        },
        SECRET,
      );
      const result = (await validator!(token)) as JwtPrincipal;
      expect(result).not.toBeNull();
      expect(result.subject).toBe("user-1");
      expect(result.issuer).toBe(ISSUER);
    });

    /**
     * @case Token with iss matching any entry in array is accepted
     * @preconditions jwt() configured with issuer: ["a", "b"] and audience; token carries iss: "b"
     * @expectedResult Validator returns a JwtPrincipal
     */
    test("accepts iss matching any entry in issuer array", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ["https://a.example.com", "https://b.example.com"],
        audience: AUDIENCE,
      });
      const token = signHs256(
        {
          sub: "user-1",
          iss: "https://b.example.com",
          aud: AUDIENCE,
          exp: FUTURE,
        },
        SECRET,
      );
      const result = await validator!(token);
      expect(result).not.toBeNull();
    });

    /**
     * @case Token with non-matching iss is rejected
     * @preconditions jwt() configured with issuer + audience; token iss is an unexpected value
     * @expectedResult Validator returns null
     */
    test("rejects non-matching iss", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        {
          sub: "user-1",
          iss: "https://evil.example.com",
          aud: AUDIENCE,
          exp: FUTURE,
        },
        SECRET,
      );
      const result = await validator!(token);
      expect(result).toBeNull();
    });

    /**
     * @case Token with missing iss is rejected
     * @preconditions jwt() configured with issuer + audience; token omits iss
     * @expectedResult Validator returns null
     */
    test("rejects missing iss", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        { sub: "user-1", aud: AUDIENCE, exp: FUTURE },
        SECRET,
      );
      const result = await validator!(token);
      expect(result).toBeNull();
    });
  });

  describe("audience validation", () => {
    /**
     * @case Token with string aud matching is accepted when audience is a single string
     * @preconditions jwt() configured with issuer + audience; token aud is the same string
     * @expectedResult Validator returns a JwtPrincipal with audience populated
     */
    test("accepts string aud matching single audience", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        { sub: "user-1", iss: ISSUER, aud: AUDIENCE, exp: FUTURE },
        SECRET,
      );
      const result = (await validator!(token)) as JwtPrincipal;
      expect(result).not.toBeNull();
      expect(result.audience).toEqual([AUDIENCE]);
    });

    /**
     * @case Token with array aud containing the expected audience is accepted
     * @preconditions jwt() configured with issuer + audience; token aud is ["other", audience]
     * @expectedResult Validator returns a JwtPrincipal
     */
    test("accepts array aud containing expected audience", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        {
          sub: "user-1",
          iss: ISSUER,
          aud: ["https://other.example.com", AUDIENCE],
          exp: FUTURE,
        },
        SECRET,
      );
      const result = await validator!(token);
      expect(result).not.toBeNull();
    });

    /**
     * @case Token with aud matching any entry when audience is an array
     * @preconditions jwt() configured with issuer + audience: ["a", "b"]; token aud is "b"
     * @expectedResult Validator returns a JwtPrincipal
     */
    test("accepts aud matching any entry in audience array", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: ["https://a.example.com", "https://b.example.com"],
      });
      const token = signHs256(
        {
          sub: "user-1",
          iss: ISSUER,
          aud: "https://b.example.com",
          exp: FUTURE,
        },
        SECRET,
      );
      const result = await validator!(token);
      expect(result).not.toBeNull();
    });

    /**
     * @case Token with non-matching aud is rejected
     * @preconditions jwt() configured with issuer + audience; token aud is unexpected
     * @expectedResult Validator returns null
     */
    test("rejects non-matching aud", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        {
          sub: "user-1",
          iss: ISSUER,
          aud: "https://evil.example.com",
          exp: FUTURE,
        },
        SECRET,
      );
      const result = await validator!(token);
      expect(result).toBeNull();
    });

    /**
     * @case Token with missing aud is rejected
     * @preconditions jwt() configured with issuer + audience; token omits aud
     * @expectedResult Validator returns null
     */
    test("rejects missing aud", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        { sub: "user-1", iss: ISSUER, exp: FUTURE },
        SECRET,
      );
      const result = await validator!(token);
      expect(result).toBeNull();
    });
  });
});
