import { describe, test, expect } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  oauth,
  oauthPrincipalFromJwtPayload,
  type OAuthFactoryOptions,
} from "../src/mcp/oauth.ts";
import type { OAuthPrincipal } from "../src/mcp/types.ts";

/** Serve a static JWK set at a local URL. Returns the URL and a close fn. */
async function serveJwks(jwks: {
  keys: unknown[];
}): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(jwks));
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
  issuerUrl: "http://localhost:9999",
  endpoints: {
    authorizationUrl: "http://localhost:9999/authorize",
    tokenUrl: "http://localhost:9999/token",
  },
  client: {
    client_id: "test-client",
    redirect_uris: ["http://localhost:3000/callback"],
  },
};

describe("oauthPrincipalFromJwtPayload()", () => {
  /**
   * @case Mapping standard JWT claims produces an OAuthPrincipal with every surfaced field populated
   * @preconditions Payload carries sub, client_id, email, name, iss, aud (array), scope (space-delimited), roles, exp
   * @expectedResult subject/clientId/email/name/issuer/audience/scopes/roles/expiresAt are all set; claims mirrors the payload
   */
  test("maps standard claims to OAuthPrincipal fields", () => {
    const payload = {
      sub: "user-42",
      client_id: "client-abc",
      email: "ada@example.com",
      name: "Ada Lovelace",
      iss: "https://idp.example.com",
      aud: ["https://mcp.example.com", "other"],
      scope: "email profile",
      roles: ["admin", "reader"],
      exp: 1_800_000_000,
    };

    const principal = oauthPrincipalFromJwtPayload(payload);

    expect(principal.kind).toBe("oauth");
    expect(principal.scheme).toBe("bearer");
    expect(principal.subject).toBe("user-42");
    expect(principal.clientId).toBe("client-abc");
    expect(principal.email).toBe("ada@example.com");
    expect(principal.name).toBe("Ada Lovelace");
    expect(principal.issuer).toBe("https://idp.example.com");
    expect(principal.audience).toEqual(["https://mcp.example.com", "other"]);
    expect(principal.scopes).toEqual(["email", "profile"]);
    expect(principal.roles).toEqual(["admin", "reader"]);
    expect(principal.expiresAt).toBe(1_800_000_000);
    expect(principal.claims).toBe(payload);
  });

  /**
   * @case Single-string aud claim is normalised to a single-entry array so downstream code can iterate uniformly
   * @preconditions Payload aud is a plain string (common shape for single-audience IdPs)
   * @expectedResult principal.audience is [aud]
   */
  test("normalises a string aud to a single-entry array", () => {
    const principal = oauthPrincipalFromJwtPayload({
      sub: "u",
      client_id: "c",
      aud: "https://mcp.example.com",
    });
    expect(principal.audience).toEqual(["https://mcp.example.com"]);
  });

  /**
   * @case Claim overrides replace the default standard-claim mapping when provided
   * @preconditions Payload uses Azure-style fields (oid for subject, azp for client, groups for roles); caller provides overrides
   * @expectedResult subject/clientId/roles come from the override callbacks, not from the defaults
   */
  test("applies per-claim overrides", () => {
    const principal = oauthPrincipalFromJwtPayload(
      {
        sub: "ignored",
        oid: "azure-user-oid",
        azp: "azure-app",
        groups: ["group-a"],
      },
      {
        subject: (p) => p["oid"] as string,
        clientId: (p) => p["azp"] as string,
        roles: (p) => p["groups"] as string[],
      },
    );
    expect(principal.subject).toBe("azure-user-oid");
    expect(principal.clientId).toBe("azure-app");
    expect(principal.roles).toEqual(["group-a"]);
  });

  /**
   * @case Client-credentials tokens (no sub) fall back to client_id for subject so machine-to-machine flows are not rejected by the built-in JWT path
   * @preconditions Payload omits sub but carries client_id
   * @expectedResult principal.subject falls back to client_id; principal.clientId also uses client_id
   */
  test("falls back to client_id when sub is absent", () => {
    const principal = oauthPrincipalFromJwtPayload({ client_id: "svc" });
    expect(principal.subject).toBe("svc");
    expect(principal.clientId).toBe("svc");
  });

  /**
   * @case Tokens that emit only azp (OIDC authorized party) are mapped without caller-provided overrides
   * @preconditions Payload has sub but no client_id; azp carries the OAuth client identifier
   * @expectedResult principal.clientId falls back to azp
   */
  test("falls back to azp when client_id is absent", () => {
    const principal = oauthPrincipalFromJwtPayload({
      sub: "user-7",
      azp: "azure-app",
    });
    expect(principal.subject).toBe("user-7");
    expect(principal.clientId).toBe("azure-app");
  });

  /**
   * @case Tokens that carry only azp and no sub still produce a valid principal instead of being rejected outright
   * @preconditions Payload has only azp
   * @expectedResult principal.subject and principal.clientId both resolve to azp
   */
  test("derives subject from azp when neither sub nor client_id is present", () => {
    const principal = oauthPrincipalFromJwtPayload({ azp: "svc" });
    expect(principal.subject).toBe("svc");
    expect(principal.clientId).toBe("svc");
  });

  /**
   * @case Tokens with no subject-shaped claim at all are rejected with a helpful message pointing at the override
   * @preconditions Payload lacks sub, client_id, and azp
   * @expectedResult Throws TypeError mentioning the supported claims
   */
  test("throws when no subject-shaped claim is present", () => {
    expect(() => oauthPrincipalFromJwtPayload({})).toThrow(
      /sub.+client_id.+azp/,
    );
  });
});

describe("oauth() factory validation", () => {
  /**
   * @case Passing both jwt and verifyAccessToken is rejected so callers cannot silently bypass one path
   * @preconditions Options carry both jwt config and a verifyAccessToken callback
   * @expectedResult Factory throws TypeError instructing the caller to pick one
   */
  test("throws when both jwt and verifyAccessToken are provided", () => {
    const invalid = {
      ...BASE_OPTIONS,
      jwt: {
        jwksUrl: "https://idp.example.com/.well-known/jwks.json",
        issuer: "https://idp.example.com",
        audience: "https://mcp.example.com",
      },
      verifyAccessToken: async () => ({}) as unknown as OAuthPrincipal,
    } as unknown as OAuthFactoryOptions;
    expect(() => oauth(invalid)).toThrow(/exactly one/);
  });

  /**
   * @case Passing neither jwt nor verifyAccessToken is rejected so the factory never produces an auth config that accepts every token
   * @preconditions Options omit both jwt and verifyAccessToken
   * @expectedResult Factory throws TypeError instructing the caller to pick one
   */
  test("throws when neither jwt nor verifyAccessToken is provided", () => {
    expect(() =>
      oauth(
        // @ts-expect-error -- intentionally invalid: the discriminated union requires exactly one
        BASE_OPTIONS,
      ),
    ).toThrow(/exactly one/);
  });

  /**
   * @case Custom verifyAccessToken is preserved on the returned McpOAuthAuthOptions so existing integrations keep working
   * @preconditions Options pass a verifyAccessToken callback and no jwt config
   * @expectedResult Returned config carries the same callback reference
   */
  test("preserves a caller-supplied verifyAccessToken", async () => {
    const verify = async (): Promise<OAuthPrincipal> => ({
      kind: "oauth",
      scheme: "bearer",
      subject: "u",
      clientId: "c",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      claims: {},
    });

    const result = oauth({ ...BASE_OPTIONS, verifyAccessToken: verify });
    expect(result.verifyAccessToken).toBe(verify);
  });

  /**
   * @case A static `client` option rejects unknown client IDs so a single-client misconfiguration cannot silently authorize others
   * @preconditions Options pass a static OAuthClientInfo with client_id "allowed"
   * @expectedResult getClient("allowed") resolves to the static object; getClient("other") resolves to undefined
   */
  test("static client rejects unknown client IDs", async () => {
    const verify = async (): Promise<OAuthPrincipal> => ({
      kind: "oauth",
      scheme: "bearer",
      subject: "u",
      clientId: "allowed",
    });
    const result = oauth({
      ...BASE_OPTIONS,
      client: {
        client_id: "allowed",
        redirect_uris: ["http://localhost:3000/callback"],
      },
      verifyAccessToken: verify,
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
      kind: "oauth",
      scheme: "bearer",
      subject: "u",
      clientId: "u",
    });
    const result = oauth({
      ...BASE_OPTIONS,
      client: async (id) => {
        calls.push(id);
        return id === "known"
          ? { client_id: "known", redirect_uris: ["http://x"] }
          : undefined;
      },
      verifyAccessToken: verify,
    });
    await expect(result.getClient("known")).resolves.toMatchObject({
      client_id: "known",
    });
    await expect(result.getClient("missing")).resolves.toBeUndefined();
    expect(calls).toEqual(["known", "missing"]);
  });
});

describe("oauth({ jwt }) end-to-end", () => {
  /**
   * @case Built-in jwt config verifies an RS256 token against a JWKS endpoint and produces a fully populated OAuthPrincipal
   * @preconditions Local HTTP server serves a JWKS with a single RS256 public key; token is signed with the matching private key and carries iss, aud, sub, client_id, name, email, scope, roles, exp
   * @expectedResult Synthesised verifyAccessToken returns an OAuthPrincipal with every identity field mapped from the payload
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
        jwt: {
          jwksUrl: url,
          issuer: "https://idp.example.com",
          audience: "https://mcp.example.com",
        },
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
   * @expectedResult verifyAccessToken rejects
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
        jwt: {
          jwksUrl: url,
          issuer: "https://idp.example.com",
          audience: "https://mcp.example.com",
        },
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
