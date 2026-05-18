import { describe, expect, test } from "bun:test";
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
   * @case oauth() carries only proxy-mechanics fields on the returned options (no protected-resource metadata)
   * @preconditions Options include verify and client; no resource metadata is accepted by the factory
   * @expectedResult Returned config has provider/endpoints/verify/client but no resourceIssuerUrl / scopesSupported / serviceDocumentationUrl / resourceName fields
   */
  test("returns proxy-mechanics fields only (no resource metadata)", () => {
    const verify = async (): Promise<OAuthPrincipal> => ({
      kind: "custom",
      scheme: "bearer",
      subject: "u",
      expiresAt: 9999999999,
    });
    const result = oauth({ ...BASE_OPTIONS, verify });
    expect(result.provider).toBe("oauth");
    expect(result.endpoints.authorizationUrl).toBe(
      BASE_OPTIONS.endpoints.authorizationUrl,
    );
    expect(typeof result.verifyAccessToken).toBe("function");
    expect(typeof result.getClient).toBe("function");
    expect(result).not.toHaveProperty("resourceIssuerUrl");
    expect(result).not.toHaveProperty("scopesSupported");
    expect(result).not.toHaveProperty("serviceDocumentationUrl");
    expect(result).not.toHaveProperty("resourceName");
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

/** Serve a configurable JSON response at a local URL. Handler receives each request. */
async function serveJson(
  handler: (req: {
    url: string;
    headers: Record<string, string | string[] | undefined>;
  }) =>
    | { status?: number; body: unknown }
    | Promise<{ status?: number; body: unknown }>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const headers = req.headers as Record<
      string,
      string | string[] | undefined
    >;
    const result = await handler({ url, headers });
    res.statusCode = result.status ?? 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

describe("oauth({ userinfo }) enrichment", () => {
  function makeVerify(subject: string, expiresIn = 60) {
    // Snapshot expiresAt at helper-creation time. Recomputing per call would
    // make deep-equality assertions (and the cache-hit tests) flaky if the
    // calls straddle a second boundary.
    const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
    return async (): Promise<OAuthPrincipal> => ({
      kind: "custom",
      scheme: "bearer",
      subject,
      expiresAt,
    });
  }

  /**
   * @case Function userinfo enriches the verified principal
   * @preconditions verify resolves a thin principal; userinfo function returns email and roles
   * @expectedResult Returned principal carries the enrichment, verify fields preserved
   */
  test("function userinfo merges onto the verified principal", async () => {
    const verify = makeVerify("user-42");
    const config = oauth({
      ...BASE_OPTIONS,
      verify,
      userinfo: async (principal) => {
        expect(principal.subject).toBe("user-42");
        return { email: "ada@example.com", roles: ["admin"] };
      },
    });

    const principal = await config.verifyAccessToken("token");
    expect(principal.subject).toBe("user-42");
    expect(principal.email).toBe("ada@example.com");
    expect(principal.roles).toEqual(["admin"]);
  });

  /**
   * @case Verify-wins merge rule: enrichment cannot overwrite subject / issuer / audience / expiresAt
   * @preconditions Function userinfo tries to overwrite all protected fields
   * @expectedResult Protected fields remain the verify values; only non-protected fields are merged
   */
  test("protected fields cannot be overwritten by userinfo", async () => {
    const verify = makeVerify("verified-sub", 120);
    const verifiedExp = (await verify()).expiresAt;
    const config = oauth({
      ...BASE_OPTIONS,
      verify,
      userinfo: async () =>
        ({
          subject: "evil-sub",
          issuer: "https://evil.example.com",
          audience: ["https://evil.example.com"],
          expiresAt: 0,
          email: "good@example.com",
        }) as unknown as Partial<OAuthPrincipal>,
    });

    const principal = await config.verifyAccessToken("token");
    expect(principal.subject).toBe("verified-sub");
    expect(principal.issuer).toBeUndefined();
    expect(principal.audience).toBeUndefined();
    expect(principal.expiresAt).toBe(verifiedExp);
    expect(principal.email).toBe("good@example.com");
  });

  /**
   * @case Explicit URL userinfo fetches the endpoint and lifts OIDC claims
   * @preconditions verify resolves sub "user-99"; local /userinfo returns sub + email
   * @expectedResult Principal.email is populated; sub invariant passes
   */
  test("string-URL userinfo lifts OIDC claims from the response", async () => {
    const { baseUrl, close } = await serveJson(({ url }) => {
      if (url === "/userinfo") {
        return {
          body: { sub: "user-99", email: "ada@example.com", name: "Ada" },
        };
      }
      return { status: 404, body: {} };
    });
    try {
      const config = oauth({
        ...BASE_OPTIONS,
        verify: makeVerify("user-99"),
        userinfo: `${baseUrl}/userinfo`,
      });
      const principal = await config.verifyAccessToken("token");
      expect(principal.email).toBe("ada@example.com");
      expect(principal.name).toBe("Ada");
    } finally {
      await close();
    }
  });

  /**
   * @case Sub mismatch between verified token and userinfo response rejects the request
   * @preconditions verify resolves sub "user-A"; userinfo response carries sub "user-B"
   * @expectedResult verifyAccessToken throws and message mentions sub mismatch
   */
  test("rejects when userinfo sub does not match token sub", async () => {
    const { baseUrl, close } = await serveJson(() => ({
      body: { sub: "user-B", email: "evil@example.com" },
    }));
    try {
      const config = oauth({
        ...BASE_OPTIONS,
        verify: makeVerify("user-A"),
        userinfo: `${baseUrl}/userinfo`,
      });
      await expect(config.verifyAccessToken("token")).rejects.toThrow(/sub/i);
    } finally {
      await close();
    }
  });

  /**
   * @case Missing sub in userinfo response rejects per OIDC Core §5.3.2
   * @preconditions Userinfo response omits sub entirely
   * @expectedResult verifyAccessToken throws with a sub-related error
   */
  test("rejects when userinfo response is missing sub", async () => {
    const { baseUrl, close } = await serveJson(() => ({
      body: { email: "x@example.com" },
    }));
    try {
      const config = oauth({
        ...BASE_OPTIONS,
        verify: makeVerify("user-A"),
        userinfo: `${baseUrl}/userinfo`,
      });
      await expect(config.verifyAccessToken("token")).rejects.toThrow(/sub/i);
    } finally {
      await close();
    }
  });

  /**
   * @case Userinfo fetch failure rejects the request (fail-closed)
   * @preconditions Userinfo URL returns 500
   * @expectedResult verifyAccessToken throws; no principal returned
   */
  test("rejects when the userinfo endpoint returns a non-2xx response", async () => {
    const { baseUrl, close } = await serveJson(() => ({
      status: 500,
      body: { error: "boom" },
    }));
    try {
      const config = oauth({
        ...BASE_OPTIONS,
        verify: makeVerify("user-A"),
        userinfo: `${baseUrl}/userinfo`,
      });
      await expect(config.verifyAccessToken("token")).rejects.toThrow();
    } finally {
      await close();
    }
  });

  /**
   * @case Token-bound cache: identical tokens skip the userinfo call on subsequent verifies
   * @preconditions Function userinfo increments a counter on each call
   * @expectedResult Counter is 1 after two verifies with the same token
   */
  test("caches the enrichment per token", async () => {
    let calls = 0;
    const config = oauth({
      ...BASE_OPTIONS,
      verify: makeVerify("user-42"),
      userinfo: async () => {
        calls += 1;
        return { email: "ada@example.com" };
      },
    });

    const a = await config.verifyAccessToken("token");
    const b = await config.verifyAccessToken("token");
    expect(calls).toBe(1);
    expect(a.email).toBe("ada@example.com");
    expect(b.email).toBe("ada@example.com");

    await config.verifyAccessToken("other-token");
    expect(calls).toBe(2);
  });

  /**
   * @case Base verifier runs on every request, even on cache hits
   * @preconditions Custom verify increments a counter; userinfo is cheap
   * @expectedResult verify is called once per verifyAccessToken; dynamic checks (introspection, revocation) keep firing
   */
  test("base verifier runs on every request (cache hits do not bypass verify)", async () => {
    let verifyCalls = 0;
    const verify = async (): Promise<OAuthPrincipal> => {
      verifyCalls += 1;
      return {
        kind: "custom",
        scheme: "bearer",
        subject: "user-42",
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      };
    };
    const config = oauth({
      ...BASE_OPTIONS,
      verify,
      userinfo: async () => ({ email: "ada@example.com" }),
    });

    await config.verifyAccessToken("token");
    await config.verifyAccessToken("token");
    await config.verifyAccessToken("token");

    expect(verifyCalls).toBe(3);
  });

  /**
   * @case userinfo: true auto-discovers the userinfo endpoint via OIDC Discovery
   * @preconditions Local server serves /.well-known/openid-configuration and /userinfo
   * @expectedResult Principal is enriched from the discovered endpoint
   */
  test("userinfo: true resolves the endpoint via OIDC Discovery", async () => {
    const { baseUrl, close } = await serveJson(({ url }) => {
      if (url === "/.well-known/openid-configuration") {
        return { body: { userinfo_endpoint: `${baseUrl}/userinfo` } };
      }
      if (url === "/userinfo") {
        return { body: { sub: "user-42", email: "ada@example.com" } };
      }
      return { status: 404, body: {} };
    });
    try {
      const config = oauth({
        ...BASE_OPTIONS,
        verify: { validator: makeVerify("user-42"), issuer: baseUrl },
        userinfo: true,
      });
      const principal = await config.verifyAccessToken("token");
      expect(principal.email).toBe("ada@example.com");
    } finally {
      await close();
    }
  });

  /**
   * @case userinfo: true throws when the discovery document does not advertise userinfo_endpoint
   * @preconditions Discovery doc returns {} (no userinfo_endpoint field)
   * @expectedResult verifyAccessToken throws a clear TypeError on first use
   */
  test("userinfo: true rejects when the discovery doc lacks userinfo_endpoint", async () => {
    const { baseUrl, close } = await serveJson(({ url }) => {
      if (url === "/.well-known/openid-configuration") {
        return { body: {} };
      }
      return { status: 404, body: {} };
    });
    try {
      const config = oauth({
        ...BASE_OPTIONS,
        verify: { validator: makeVerify("user-42"), issuer: baseUrl },
        userinfo: true,
      });
      await expect(config.verifyAccessToken("token")).rejects.toThrow(
        /userinfo_endpoint/,
      );
    } finally {
      await close();
    }
  });

  /**
   * @case userinfo: true throws at construction time when verify exposes no issuer
   * @preconditions verify is a raw function (no issuer metadata)
   * @expectedResult oauth() throws TypeError mentioning issuer
   */
  test("userinfo: true requires issuer to be exposed by the verifier", () => {
    expect(() =>
      oauth({
        ...BASE_OPTIONS,
        verify: makeVerify("user-42"),
        userinfo: true,
      }),
    ).toThrow(/issuer/i);
  });

  /**
   * @case userinfo: true with array issuer is rejected at construction time
   * @preconditions Verifier exposes issuer as a string[]
   * @expectedResult oauth() throws TypeError mentioning array
   */
  test("userinfo: true rejects an array issuer", () => {
    expect(() =>
      oauth({
        ...BASE_OPTIONS,
        verify: {
          validator: makeVerify("user-42"),
          issuer: ["https://a", "https://b"],
        },
        userinfo: true,
      }),
    ).toThrow(/array|single/i);
  });

  /**
   * @case oauth() throws fail-fast when verify is missing, even with userinfo set
   * @preconditions options.verify is undefined; options.userinfo is set (would have masked the check)
   * @expectedResult Factory throws TypeError mentioning verify at construction time
   */
  test("oauth() rejects missing verify even when userinfo is set", () => {
    expect(() =>
      oauth({
        ...BASE_OPTIONS,
        verify: undefined as unknown as ReturnType<typeof makeVerify>,
        userinfo: async () => ({}),
      }),
    ).toThrow(/verify/i);
  });

  /**
   * @case userinfo absent leaves oauth() behaviour unchanged (regression guard)
   * @preconditions Same options minus userinfo; verify resolves a thin principal
   * @expectedResult Principal returned by verifyAccessToken matches the raw verify output via deep equality
   */
  test("oauth() without userinfo is unchanged", async () => {
    const verify = makeVerify("user-42");
    const baseline = await verify();
    const config = oauth({ ...BASE_OPTIONS, verify });
    const principal = await config.verifyAccessToken("token");
    expect(principal).toEqual(baseline);
  });

  /**
   * @case URL-mode enrichment preserves the verified JWT payload on principal.claims
   * @preconditions verify returns a principal with claims = {iat, custom}; userinfo response carries different fields
   * @expectedResult principal.claims is unchanged; userinfo response lives on principal.userinfoClaims
   */
  test("URL-mode enrichment preserves principal.claims and stashes userinfo on userinfoClaims", async () => {
    const jwtClaims = { iat: 1700000000, custom: "v" };
    const verify = async (): Promise<OAuthPrincipal> => ({
      kind: "jwks",
      scheme: "bearer",
      subject: "user-42",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      claims: jwtClaims,
    });
    const { baseUrl, close } = await serveJson(({ url }) => {
      if (url === "/userinfo") {
        return {
          body: {
            sub: "user-42",
            email: "ada@example.com",
            picture: "https://example.com/p.png",
          },
        };
      }
      return { status: 404, body: {} };
    });
    try {
      const config = oauth({
        ...BASE_OPTIONS,
        verify,
        userinfo: `${baseUrl}/userinfo`,
      });
      const principal = await config.verifyAccessToken("token");
      expect(principal.claims).toEqual(jwtClaims);
      expect(principal.userinfoClaims).toEqual({
        sub: "user-42",
        email: "ada@example.com",
        picture: "https://example.com/p.png",
      });
      expect(principal.email).toBe("ada@example.com");
    } finally {
      await close();
    }
  });

  /**
   * @case OIDC discovery retries on transient failure rather than caching the rejection
   * @preconditions Discovery endpoint returns 500 on first call and 200 on second
   * @expectedResult First verifyAccessToken rejects with RC5021; second succeeds
   */
  test("OIDC discovery retries after a transient failure", async () => {
    let calls = 0;
    const { baseUrl, close } = await serveJson(({ url }) => {
      if (url === "/.well-known/openid-configuration") {
        calls += 1;
        if (calls === 1) return { status: 500, body: { error: "boom" } };
        return { body: { userinfo_endpoint: `${baseUrl}/userinfo` } };
      }
      if (url === "/userinfo") {
        return { body: { sub: "user-42", email: "ada@example.com" } };
      }
      return { status: 404, body: {} };
    });
    try {
      const config = oauth({
        ...BASE_OPTIONS,
        verify: { validator: makeVerify("user-42"), issuer: baseUrl },
        userinfo: true,
      });
      await expect(config.verifyAccessToken("token-a")).rejects.toThrow(
        /RC5021|Discovery/,
      );
      const principal = await config.verifyAccessToken("token-b");
      expect(principal.email).toBe("ada@example.com");
      expect(calls).toBe(2);
    } finally {
      await close();
    }
  });

  /**
   * @case OIDC discovery preserves the issuer's path component (Keycloak realm, Azure tenant)
   * @preconditions issuer ends with "/realms/test"; discovery doc is served under that prefix
   * @expectedResult Discovery resolves at "/realms/test/.well-known/openid-configuration" and enrichment succeeds
   */
  test("OIDC discovery preserves issuer path component", async () => {
    const { baseUrl, close } = await serveJson(({ url }) => {
      if (url === "/realms/test/.well-known/openid-configuration") {
        return {
          body: { userinfo_endpoint: `${baseUrl}/realms/test/userinfo` },
        };
      }
      if (url === "/realms/test/userinfo") {
        return { body: { sub: "user-42", email: "ada@example.com" } };
      }
      return { status: 404, body: {} };
    });
    try {
      const config = oauth({
        ...BASE_OPTIONS,
        verify: {
          validator: makeVerify("user-42"),
          issuer: `${baseUrl}/realms/test`,
        },
        userinfo: true,
      });
      const principal = await config.verifyAccessToken("token");
      expect(principal.email).toBe("ada@example.com");
    } finally {
      await close();
    }
  });
});
