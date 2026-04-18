import { describe, test, expect } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { jwks } from "@routecraft/routecraft";
import { oauth } from "../src/mcp/oauth.ts";
import type { OAuthPrincipal } from "@routecraft/routecraft";

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

/** Handy stub for required factory options used across tests. */
const BASE_OPTIONS = {
  resourceIssuerUrl: "http://localhost:9999",
  endpoints: {
    authorizationUrl: "http://localhost:9999/authorize",
    tokenUrl: "http://localhost:9999/token",
  },
  client: {
    client_id: "test-client",
    redirect_uris: ["http://localhost:3000/callback"],
  },
};

describe("oauth() factory", () => {
  /**
   * @case Custom TokenVerifier function is wired directly as verifyAccessToken
   * @preconditions Options pass a raw (token) => Principal function as verify
   * @expectedResult Returned config's verifyAccessToken invokes the function; returned principal matches
   */
  test("accepts a raw TokenVerifier function as verify", async () => {
    const verify = async (): Promise<OAuthPrincipal> => ({
      kind: "custom",
      scheme: "bearer",
      subject: "u",
      clientId: "c",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });

    const result = oauth({ ...BASE_OPTIONS, verify });
    const principal = await result.verifyAccessToken("any-token");
    expect(principal.subject).toBe("u");
    expect(principal.clientId).toBe("c");
  });

  /**
   * @case ValidatorAuthOptions (from jwks()) is composed into verifyAccessToken
   * @preconditions Options pass a jwks() result as verify
   * @expectedResult Factory wires up the validator; verifyAccessToken delegates to it
   */
  test("accepts a ValidatorAuthOptions (from jwks()) as verify", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test-key";
    jwk.alg = "RS256";
    jwk.use = "sig";
    const { url, close } = await serveJwks({ keys: [jwk] });

    try {
      const verifyOptions = jwks({
        jwksUrl: url,
        issuer: "https://idp.example.com",
        audience: "https://mcp.example.com",
      });

      const config = oauth({ ...BASE_OPTIONS, verify: verifyOptions });

      const token = await new SignJWT({ client_id: "client-abc" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer("https://idp.example.com")
        .setAudience("https://mcp.example.com")
        .setSubject("user-42")
        .setExpirationTime("1h")
        .sign(privateKey);

      const principal = await config.verifyAccessToken(token);
      expect(principal.subject).toBe("user-42");
      expect(principal.kind).toBe("jwks");
    } finally {
      await close();
    }
  });

  /**
   * @case A static `client` option rejects unknown client IDs
   * @preconditions Options pass a static OAuthClientInfo with client_id "allowed"
   * @expectedResult getClient("allowed") resolves to the static object; getClient("other") resolves to undefined
   */
  test("static client rejects unknown client IDs", async () => {
    const verify = async (): Promise<OAuthPrincipal> => ({
      kind: "custom",
      scheme: "bearer",
      subject: "u",
      clientId: "allowed",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    const result = oauth({
      ...BASE_OPTIONS,
      client: {
        client_id: "allowed",
        redirect_uris: ["http://localhost:3000/callback"],
      },
      verify,
    });
    await expect(result.getClient("allowed")).resolves.toMatchObject({
      client_id: "allowed",
    });
    await expect(result.getClient("other")).resolves.toBeUndefined();
  });

  /**
   * @case A supplier `client` option is invoked per request with the incoming client_id
   * @preconditions Options pass an async supplier that returns a registration record only for a specific ID
   * @expectedResult Supplier is called with the exact clientId; missing entries surface as undefined
   */
  test("supplier client is invoked per lookup", async () => {
    const calls: string[] = [];
    const verify = async (): Promise<OAuthPrincipal> => ({
      kind: "custom",
      scheme: "bearer",
      subject: "u",
      clientId: "u",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    const result = oauth({
      ...BASE_OPTIONS,
      client: async (id) => {
        calls.push(id);
        return id === "known"
          ? { client_id: "known", redirect_uris: ["http://x"] }
          : undefined;
      },
      verify,
    });
    await expect(result.getClient("known")).resolves.toMatchObject({
      client_id: "known",
    });
    await expect(result.getClient("missing")).resolves.toBeUndefined();
    expect(calls).toEqual(["known", "missing"]);
  });

  /**
   * @case resourceIssuerUrl is surfaced on the returned OAuthAuthOptions
   * @preconditions Options with a valid resourceIssuerUrl
   * @expectedResult Returned config.resourceIssuerUrl matches input
   */
  test("exposes resourceIssuerUrl on returned config", () => {
    const verify = async (): Promise<OAuthPrincipal> => ({
      kind: "custom",
      scheme: "bearer",
      subject: "u",
      expiresAt: 9999999999,
    });
    const result = oauth({ ...BASE_OPTIONS, verify });
    expect(result.resourceIssuerUrl.toString()).toBe("http://localhost:9999");
  });
});

describe("oauth({ verify: jwks(...) }) end-to-end", () => {
  /**
   * @case Built-in jwks() verify config verifies an RS256 token and produces a fully populated Principal
   * @preconditions Local HTTP server serves a JWKS with a single RS256 public key; token carries all standard claims
   * @expectedResult verifyAccessToken returns a Principal with kind "jwks" and all identity fields mapped
   */
  test("verifies a JWKS-signed token and maps claims", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test-key";
    jwk.alg = "RS256";
    jwk.use = "sig";
    const { url, close } = await serveJwks({ keys: [jwk] });

    try {
      const config = oauth({
        ...BASE_OPTIONS,
        verify: jwks({
          jwksUrl: url,
          issuer: "https://idp.example.com",
          audience: "https://mcp.example.com",
        }),
      });

      const token = await new SignJWT({
        client_id: "client-abc",
        email: "ada@example.com",
        name: "Ada Lovelace",
        scope: "email profile",
        roles: ["admin"],
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer("https://idp.example.com")
        .setAudience("https://mcp.example.com")
        .setSubject("user-42")
        .setExpirationTime("1h")
        .sign(privateKey);

      const principal = await config.verifyAccessToken(token);
      expect(principal.kind).toBe("jwks");
      expect(principal.subject).toBe("user-42");
      expect(principal.clientId).toBe("client-abc");
      expect(principal.email).toBe("ada@example.com");
      expect(principal.name).toBe("Ada Lovelace");
      expect(principal.issuer).toBe("https://idp.example.com");
      expect(principal.audience).toEqual(["https://mcp.example.com"]);
      expect(principal.scopes).toEqual(["email", "profile"]);
      expect(principal.roles).toEqual(["admin"]);
      expect(principal.expiresAt).toBeTypeOf("number");
    } finally {
      await close();
    }
  });

  /**
   * @case Token signed with the wrong audience is rejected so cross-audience replay is impossible via the built-in path
   * @preconditions JWKS endpoint serves a valid key; token aud does not include the configured audience
   * @expectedResult verifyAccessToken rejects (throws)
   */
  test("rejects a token with a mismatched aud", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test-key";
    jwk.alg = "RS256";
    jwk.use = "sig";
    const { url, close } = await serveJwks({ keys: [jwk] });

    try {
      const config = oauth({
        ...BASE_OPTIONS,
        verify: jwks({
          jwksUrl: url,
          issuer: "https://idp.example.com",
          audience: "https://mcp.example.com",
        }),
      });

      const token = await new SignJWT({ client_id: "c" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer("https://idp.example.com")
        .setAudience("https://other.example.com")
        .setSubject("u")
        .setExpirationTime("1h")
        .sign(privateKey);

      await expect(config.verifyAccessToken(token)).rejects.toThrow();
    } finally {
      await close();
    }
  });
});
