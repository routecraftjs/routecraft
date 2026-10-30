import { createHash } from "node:crypto";
import { statefulRemote } from "./stateful-remote.ts";

/**
 * A remote MCP server behind an OAuth login, with its authorization server,
 * reached through a stubbed `fetch`.
 *
 * The MCP server answers 401 without a bearer token it issued, and
 * advertises the authorization server through RFC 9728 metadata. The
 * authorization server issues codes for any client, checks the PKCE
 * verifier against the challenge, exchanges each code once for an
 * access token and a refresh token, and rotates the refresh token on every
 * refresh: a refresh token works once.
 */
export function oauthRemote(mcpUrl: string, issuer = "https://as.test") {
  const remote = statefulRemote(mcpUrl);
  const inner = globalThis.fetch;
  const resource = new URL(mcpUrl);
  const metadataUrl = `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname}`;
  const validAccess = new Set<string>();
  const validRefresh = new Set<string>();
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  let issued = 0;
  let tokenOutage = false;
  const tokenRequests: URLSearchParams[] = [];
  const counts = { authorized: 0, refreshed: 0, refused: 0 };

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function issue(): Record<string, unknown> {
    issued += 1;
    const access = `access-${issued}`;
    const refresh = `refresh-${issued}`;
    validAccess.add(access);
    validRefresh.add(refresh);
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: 3600,
    };
  }

  async function handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.href === metadataUrl) {
      return json({ resource: mcpUrl, authorization_servers: [issuer] });
    }
    if (url.origin === issuer) {
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        });
      }
      if (url.pathname === "/token" && request.method === "POST") {
        if (tokenOutage) {
          tokenOutage = false;
          return new Response("Service Unavailable", { status: 503 });
        }
        const form = new URLSearchParams(await request.text());
        tokenRequests.push(form);
        if (form.get("grant_type") === "authorization_code") {
          const code = codes.get(form.get("code") ?? "");
          const verifier = form.get("code_verifier") ?? "";
          const challenge = createHash("sha256")
            .update(verifier)
            .digest("base64url");
          if (
            !code ||
            form.get("redirect_uri") !== code.redirectUri ||
            challenge !== code.challenge
          ) {
            return json({ error: "invalid_grant" }, 400);
          }
          codes.delete(form.get("code") ?? "");
          counts.authorized++;
          return json(issue());
        }
        if (form.get("grant_type") === "refresh_token") {
          const token = form.get("refresh_token") ?? "";
          if (!validRefresh.delete(token)) {
            counts.refused++;
            return json({ error: "invalid_grant" }, 400);
          }
          counts.refreshed++;
          return json(issue());
        }
        return json({ error: "unsupported_grant_type" }, 400);
      }
      return new Response("Not Found", { status: 404 });
    }
    if (request.url.startsWith(mcpUrl)) {
      const bearer = request.headers
        .get("authorization")
        ?.replace(/^Bearer /, "");
      if (bearer === undefined || !validAccess.has(bearer)) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${metadataUrl}"`,
          },
        });
      }
    }
    return undefined;
  }

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const answered = await handle(request.clone());
    return answered ?? inner(input, init);
  }) as typeof fetch;

  return {
    remote,
    counts,
    tokenRequests,
    /**
     * Play the person's browser: consent at the authorization URL and
     * return the redirect's query, as the loopback listener would see it.
     */
    consent(authorizationUrl: URL): URLSearchParams {
      const redirectUri = authorizationUrl.searchParams.get("redirect_uri")!;
      const code = `code-${codes.size + 1}-${issued}`;
      codes.set(code, {
        challenge: authorizationUrl.searchParams.get("code_challenge")!,
        redirectUri,
      });
      const back = new URLSearchParams({ code, iss: issuer });
      const state = authorizationUrl.searchParams.get("state");
      if (state !== null) back.set("state", state);
      return back;
    },
    /** Expire every access token, as time passing does. */
    expireAccess(): void {
      validAccess.clear();
    },
    /** Answer the next token request with 503, as an outage does. */
    tokenEndpointDown(): void {
      tokenOutage = true;
    },
    /** Revoke every refresh token, as a password change does. */
    revokeRefresh(): void {
      validRefresh.clear();
    },
    restore(): void {
      globalThis.fetch = inner;
      remote.restore();
    },
  };
}
