import { describe, test, expect } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { jwks } from "../../src/auth/jwks.ts";

/** Serve a static JWK set at a local URL. Returns the URL and a close fn. */
async function serveJwks(jwkSet: {
  keys: unknown[];
}): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(jwkSet));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/jwks.json`,
    server,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

const ISSUER = "https://idp.example.com";
const AUDIENCE = "https://mcp.example.com";

describe("jwks()", () => {
  describe("required options", () => {
    /**
     * @case Factory rejects options that omit issuer to prevent cross-issuer replay
     * @preconditions jwks() called without issuer
     * @expectedResult Throws TypeError mentioning issuer
     */
    test("throws when issuer is omitted", () => {
      expect(() =>
        jwks({
          jwksUrl: "http://localhost/jwks.json",
          audience: AUDIENCE,
        } as unknown as Parameters<typeof jwks>[0]),
      ).toThrow(/issuer/);
    });

    /**
     * @case Factory rejects options that omit audience to prevent cross-audience replay
     * @preconditions jwks() called without audience
     * @expectedResult Throws TypeError mentioning audience
     */
    test("throws when audience is omitted", () => {
      expect(() =>
        jwks({
          jwksUrl: "http://localhost/jwks.json",
          issuer: ISSUER,
        } as unknown as Parameters<typeof jwks>[0]),
      ).toThrow(/audience/);
    });

    /**
     * @case Factory accepts "*" as a valid audience sentinel
     * @preconditions jwks() called with audience: "*"
     * @expectedResult No error thrown
     */
    test('accepts "*" as audience sentinel', () => {
      expect(() =>
        jwks({
          jwksUrl: "http://localhost/jwks.json",
          issuer: ISSUER,
          audience: "*",
        }),
      ).not.toThrow();
    });
  });

  describe("token verification", () => {
    /**
     * @case JWKS-signed RS256 token with matching claims is accepted and mapped to a Principal
     * @preconditions Local JWKS server; token signed with matching RS256 key; iss and aud match
     * @expectedResult Validator resolves to Principal with kind "jwks" and all fields populated
     */
    test("verifies a JWKS-signed token and maps claims to Principal", async () => {
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      const jwk = await exportJWK(publicKey);
      jwk.kid = "test-key";
      jwk.alg = "RS256";
      jwk.use = "sig";
      const { url, close } = await serveJwks({ keys: [jwk] });

      try {
        const { validator } = jwks({
          jwksUrl: url,
          issuer: ISSUER,
          audience: AUDIENCE,
        });

        const token = await new SignJWT({
          client_id: "client-abc",
          email: "ada@example.com",
          name: "Ada Lovelace",
          scope: "email profile",
          roles: ["admin"],
        })
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setSubject("user-42")
          .setExpirationTime("1h")
          .sign(privateKey);

        const principal = await validator(token);
        expect(principal.kind).toBe("jwks");
        expect(principal.scheme).toBe("bearer");
        expect(principal.subject).toBe("user-42");
        expect(principal.clientId).toBe("client-abc");
        expect(principal.email).toBe("ada@example.com");
        expect(principal.name).toBe("Ada Lovelace");
        expect(principal.issuer).toBe(ISSUER);
        expect(principal.audience).toEqual([AUDIENCE]);
        expect(principal.scopes).toEqual(["email", "profile"]);
        expect(principal.roles).toEqual(["admin"]);
        expect(principal.expiresAt).toBeTypeOf("number");
        expect(principal.claims).toMatchObject({ sub: "user-42" });
      } finally {
        await close();
      }
    });

    /**
     * @case Token signed with a mismatched audience is rejected
     * @preconditions JWKS endpoint serves a valid key; token aud does not include the configured audience
     * @expectedResult Validator rejects (throws)
     */
    test("rejects a token with a mismatched aud", async () => {
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      const jwk = await exportJWK(publicKey);
      jwk.kid = "test-key";
      jwk.alg = "RS256";
      jwk.use = "sig";
      const { url, close } = await serveJwks({ keys: [jwk] });

      try {
        const { validator } = jwks({
          jwksUrl: url,
          issuer: ISSUER,
          audience: AUDIENCE,
        });

        const token = await new SignJWT({})
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setIssuer(ISSUER)
          .setAudience("https://other.example.com")
          .setSubject("u")
          .setExpirationTime("1h")
          .sign(privateKey);

        await expect(validator(token)).rejects.toThrow();
      } finally {
        await close();
      }
    });

    /**
     * @case Token with a mismatched issuer is rejected
     * @preconditions JWKS endpoint serves a valid key; token iss does not match configured issuer
     * @expectedResult Validator rejects (throws)
     */
    test("rejects a token with a mismatched iss", async () => {
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      const jwk = await exportJWK(publicKey);
      jwk.kid = "test-key";
      jwk.alg = "RS256";
      jwk.use = "sig";
      const { url, close } = await serveJwks({ keys: [jwk] });

      try {
        const { validator } = jwks({
          jwksUrl: url,
          issuer: ISSUER,
          audience: AUDIENCE,
        });

        const token = await new SignJWT({})
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setIssuer("https://evil.example.com")
          .setAudience(AUDIENCE)
          .setSubject("u")
          .setExpirationTime("1h")
          .sign(privateKey);

        await expect(validator(token)).rejects.toThrow();
      } finally {
        await close();
      }
    });

    /**
     * @case Token with any aud is accepted when audience is "*"
     * @preconditions JWKS endpoint valid; token carries unexpected aud; audience config is "*"
     * @expectedResult Validator resolves; audience field is mapped from token payload
     */
    test('accepts any aud when audience is "*"', async () => {
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      const jwk = await exportJWK(publicKey);
      jwk.kid = "test-key";
      jwk.alg = "RS256";
      jwk.use = "sig";
      const { url, close } = await serveJwks({ keys: [jwk] });

      try {
        const { validator } = jwks({
          jwksUrl: url,
          issuer: ISSUER,
          audience: "*",
        });

        const token = await new SignJWT({})
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setIssuer(ISSUER)
          .setAudience("some-other-resource")
          .setSubject("user-1")
          .setExpirationTime("1h")
          .sign(privateKey);

        const principal = await validator(token);
        expect(principal.subject).toBe("user-1");
        expect(principal.audience).toEqual(["some-other-resource"]);
      } finally {
        await close();
      }
    });

    /**
     * @case Token without aud is accepted when audience is "*"
     * @preconditions JWKS endpoint valid; token omits aud; audience config is "*"
     * @expectedResult Validator resolves; principal.audience is undefined
     */
    test('accepts token with no aud when audience is "*"', async () => {
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      const jwk = await exportJWK(publicKey);
      jwk.kid = "test-key";
      jwk.alg = "RS256";
      jwk.use = "sig";
      const { url, close } = await serveJwks({ keys: [jwk] });

      try {
        const { validator } = jwks({
          jwksUrl: url,
          issuer: ISSUER,
          audience: "*",
        });

        const token = await new SignJWT({})
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setIssuer(ISSUER)
          .setSubject("user-1")
          .setExpirationTime("1h")
          .sign(privateKey);

        const principal = await validator(token);
        expect(principal.subject).toBe("user-1");
        expect(principal.audience).toBeUndefined();
      } finally {
        await close();
      }
    });
  });

  describe("claims mappers", () => {
    /**
     * @case Custom subject mapper overrides the default sub extraction
     * @preconditions jwks() with claims.subject override; token carries non-standard identity field
     * @expectedResult Principal.subject comes from the override callback
     */
    test("applies claims.subject override", async () => {
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      const jwk = await exportJWK(publicKey);
      jwk.kid = "test-key";
      jwk.alg = "RS256";
      jwk.use = "sig";
      const { url, close } = await serveJwks({ keys: [jwk] });

      try {
        const { validator } = jwks({
          jwksUrl: url,
          issuer: ISSUER,
          audience: AUDIENCE,
          claims: { subject: (p) => p["oid"] as string },
        });

        const token = await new SignJWT({ oid: "azure-oid", sub: "ignored" })
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setExpirationTime("1h")
          .sign(privateKey);

        const principal = await validator(token);
        expect(principal.subject).toBe("azure-oid");
      } finally {
        await close();
      }
    });

    /**
     * @case Client-credentials tokens (no sub) fall back to client_id for subject
     * @preconditions Token omits sub but carries client_id
     * @expectedResult principal.subject is the client_id value
     */
    test("falls back to client_id when sub is absent", async () => {
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      const jwk = await exportJWK(publicKey);
      jwk.kid = "test-key";
      jwk.alg = "RS256";
      jwk.use = "sig";
      const { url, close } = await serveJwks({ keys: [jwk] });

      try {
        const { validator } = jwks({
          jwksUrl: url,
          issuer: ISSUER,
          audience: AUDIENCE,
        });

        const token = await new SignJWT({ client_id: "svc-account" })
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setExpirationTime("1h")
          .sign(privateKey);

        const principal = await validator(token);
        expect(principal.subject).toBe("svc-account");
        expect(principal.clientId).toBe("svc-account");
      } finally {
        await close();
      }
    });
  });
});
