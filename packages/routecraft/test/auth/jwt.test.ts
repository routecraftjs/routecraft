import { describe, test, expect } from "vitest";
import { createHmac } from "node:crypto";
import { jwt, type JwtAuthOptions } from "../../src/auth/jwt.ts";
import type { Principal } from "../../src/auth/types.ts";

/**
 * Sign a JWT with HS256 using the test secret. Returns the full compact
 * token without pulling in a JWT library.
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

    /**
     * @case Factory accepts "*" as a valid audience sentinel
     * @preconditions jwt() called with audience: "*"
     * @expectedResult No error thrown
     */
    test('accepts "*" as audience sentinel', () => {
      expect(() =>
        jwt({ secret: SECRET, issuer: ISSUER, audience: "*" }),
      ).not.toThrow();
    });
  });

  describe("issuer validation", () => {
    /**
     * @case Token with matching iss is accepted when issuer is a single string
     * @preconditions jwt() configured with issuer and audience; token carries both claims matching
     * @expectedResult Validator resolves to a Principal with subject from sub
     */
    test("accepts matching iss when issuer is a single string", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        { sub: "user-1", iss: ISSUER, aud: AUDIENCE, exp: FUTURE },
        SECRET,
      );
      const result = (await validator(token)) as Principal;
      expect(result.subject).toBe("user-1");
      expect(result.issuer).toBe(ISSUER);
      expect(result.kind).toBe("jwt");
    });

    /**
     * @case Token with iss matching any entry in array is accepted
     * @preconditions jwt() configured with issuer: ["a", "b"] and audience; token carries iss: "b"
     * @expectedResult Validator resolves to a Principal
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
      await expect(validator(token)).resolves.toBeDefined();
    });

    /**
     * @case Token with non-matching iss is rejected
     * @preconditions jwt() configured with issuer + audience; token iss is an unexpected value
     * @expectedResult Validator throws
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
      await expect(validator(token)).rejects.toThrow();
    });

    /**
     * @case Token with missing iss is rejected
     * @preconditions jwt() configured with issuer + audience; token omits iss
     * @expectedResult Validator throws
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
      await expect(validator(token)).rejects.toThrow();
    });
  });

  describe("audience validation", () => {
    /**
     * @case Token with string aud matching is accepted when audience is a single string
     * @preconditions jwt() configured with issuer + audience; token aud is the same string
     * @expectedResult Validator resolves to a Principal with audience populated
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
      const result = (await validator(token)) as Principal;
      expect(result.audience).toEqual([AUDIENCE]);
    });

    /**
     * @case Token with array aud containing the expected audience is accepted
     * @preconditions jwt() configured with issuer + audience; token aud is ["other", audience]
     * @expectedResult Validator resolves to a Principal
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
      await expect(validator(token)).resolves.toBeDefined();
    });

    /**
     * @case Token with aud matching any entry when audience is an array
     * @preconditions jwt() configured with issuer + audience: ["a", "b"]; token aud is "b"
     * @expectedResult Validator resolves to a Principal
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
      await expect(validator(token)).resolves.toBeDefined();
    });

    /**
     * @case Token with non-matching aud is rejected
     * @preconditions jwt() configured with issuer + audience; token aud is unexpected
     * @expectedResult Validator throws
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
      await expect(validator(token)).rejects.toThrow();
    });

    /**
     * @case Token with missing aud is rejected when audience is a specific value
     * @preconditions jwt() configured with issuer + audience; token omits aud
     * @expectedResult Validator throws
     */
    test("rejects missing aud when audience is a specific value", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        { sub: "user-1", iss: ISSUER, exp: FUTURE },
        SECRET,
      );
      await expect(validator(token)).rejects.toThrow();
    });

    /**
     * @case Token with any aud is accepted when audience is "*"
     * @preconditions jwt() configured with audience: "*"; token carries unexpected aud
     * @expectedResult Validator resolves; audience field mapped from token payload
     */
    test('accepts any aud when audience is "*"', async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: "*",
      });
      const token = signHs256(
        { sub: "user-1", iss: ISSUER, aud: "some-other-resource", exp: FUTURE },
        SECRET,
      );
      const result = await validator(token);
      expect(result.subject).toBe("user-1");
      expect(result.audience).toEqual(["some-other-resource"]);
    });

    /**
     * @case Token with no aud is accepted when audience is "*"
     * @preconditions jwt() configured with audience: "*"; token omits aud
     * @expectedResult Validator resolves; principal.audience is undefined
     */
    test('accepts token with no aud when audience is "*"', async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: "*",
      });
      const token = signHs256(
        { sub: "user-1", iss: ISSUER, exp: FUTURE },
        SECRET,
      );
      const result = await validator(token);
      expect(result.subject).toBe("user-1");
      expect(result.audience).toBeUndefined();
    });
  });

  describe("claims mappers", () => {
    /**
     * @case Custom subject mapper overrides the default sub extraction
     * @preconditions jwt() with claims.subject override; token carries non-standard identity field
     * @expectedResult Principal.subject comes from the override callback
     */
    test("applies claims.subject override", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
        claims: { subject: (p) => p["oid"] as string },
      });
      const token = signHs256(
        {
          oid: "azure-oid",
          sub: "ignored",
          iss: ISSUER,
          aud: AUDIENCE,
          exp: FUTURE,
        },
        SECRET,
      );
      const result = await validator(token);
      expect(result.subject).toBe("azure-oid");
    });

    /**
     * @case Custom roles mapper overrides the default roles extraction
     * @preconditions jwt() with claims.roles override; token carries roles under non-standard key
     * @expectedResult Principal.roles comes from the override callback
     */
    test("applies claims.roles override", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
        claims: {
          roles: (p) => p["groups"] as string[],
        },
      });
      const token = signHs256(
        {
          sub: "u",
          iss: ISSUER,
          aud: AUDIENCE,
          exp: FUTURE,
          groups: ["admin"],
        },
        SECRET,
      );
      const result = await validator(token);
      expect(result.roles).toEqual(["admin"]);
    });
  });

  describe("principal shape", () => {
    /**
     * @case Standard JWT claims are mapped to the unified Principal fields
     * @preconditions Token carries sub, iss, aud, exp, email, name, scope, roles
     * @expectedResult All standard fields surface on the returned Principal with kind "jwt"
     */
    test("maps standard claims to Principal fields", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        {
          sub: "user-42",
          client_id: "client-abc",
          iss: ISSUER,
          aud: AUDIENCE,
          exp: FUTURE,
          email: "ada@example.com",
          name: "Ada Lovelace",
          scope: "email profile",
          roles: ["admin"],
        },
        SECRET,
      );
      const result = await validator(token);
      expect(result.kind).toBe("jwt");
      expect(result.scheme).toBe("bearer");
      expect(result.subject).toBe("user-42");
      expect(result.clientId).toBe("client-abc");
      expect(result.email).toBe("ada@example.com");
      expect(result.name).toBe("Ada Lovelace");
      expect(result.issuer).toBe(ISSUER);
      expect(result.audience).toEqual([AUDIENCE]);
      expect(result.scopes).toEqual(["email", "profile"]);
      expect(result.roles).toEqual(["admin"]);
      expect(result.expiresAt).toBe(FUTURE);
      expect(result.claims).toMatchObject({ sub: "user-42" });
    });

    /**
     * @case Token without sub falls back to client_id for subject
     * @preconditions Token omits sub but carries client_id (client-credentials pattern)
     * @expectedResult Principal.subject is the client_id value
     */
    test("falls back to client_id when sub is absent", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        { client_id: "svc-account", iss: ISSUER, aud: AUDIENCE, exp: FUTURE },
        SECRET,
      );
      const result = await validator(token);
      expect(result.subject).toBe("svc-account");
    });
  });
});
