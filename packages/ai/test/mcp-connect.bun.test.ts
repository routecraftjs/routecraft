import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import {
  collectCredentialLogins,
  craft,
  credentialsPlugin,
  direct,
  MemoryCredentialStore,
  noop,
  type CredentialLoginIO,
  type CredentialStore,
} from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import { connect, mcpPlugin } from "../src/index.ts";
import { connectLogin } from "../src/mcp/connect.ts";
import { MCP } from "../src/mcp/port.ts";
import { dispatchMcpCall } from "../src/mcp/dispatch.ts";
import { oauthRemote } from "./helpers/oauth-remote.ts";

const URL_ = "http://remote.test/mcp";

// Another suite may have replaced the SDK loader with a mock; this one
// drives the real client and the real OAuth flow.
const sdk = await import("../src/mcp/sdk.ts");
const prior = { ...sdk };
mock.module("../src/mcp/sdk.ts", () => ({
  ...prior,
  loadMcpClientSdk: async () => import("@modelcontextprotocol/client"),
}));
afterAll(() => {
  mock.module("../src/mcp/sdk.ts", () => prior);
});

describe("connect(): MCP clients behind an OAuth login", () => {
  let t: TestContext | undefined;
  let server: ReturnType<typeof oauthRemote> | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
    server?.restore();
    server = undefined;
  });

  /** Log `mail` in through the fake browser, as `craft connect mail` does. */
  async function login(
    store: CredentialStore,
    auth = connect({ clientId: "app-1", scopes: ["mail.read"] }),
  ): Promise<URL> {
    let seen: URL | undefined;
    let back: URLSearchParams | undefined;
    const io: CredentialLoginIO = {
      redirectUrl: "http://127.0.0.1:53682/callback",
      openUrl: async (url) => {
        seen = url;
        back = server!.consent(url);
      },
      waitForCallback: async () => back!,
    };
    await connectLogin("mail", URL_, auth).login(store, io);
    return seen!;
  }

  async function start(store: CredentialStore) {
    t = await testContext()
      .with({
        plugins: [
          credentialsPlugin({ store }),
          mcpPlugin({
            clients: {
              mail: {
                url: URL_,
                auth: connect({ clientId: "app-1", scopes: ["mail.read"] }),
              },
            },
            toolRefreshInterval: 0,
          }),
        ],
      })
      .routes([craft().id("idle").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();
    return t.ctx.lookup(MCP)!;
  }

  /**
   * @case A login stores the credential the authorization server issued
   * @preconditions An MCP server advertising its authorization server; a configured client id and scope
   * @expectedResult The authorization URL carries the client id, scope, PKCE challenge, state and resource; the store holds the issued tokens under mcp:mail
   */
  test("a login stores the issued tokens", async () => {
    server = oauthRemote(URL_);
    const store = new MemoryCredentialStore();
    const url = await login(store);
    expect(url.origin + url.pathname).toBe("https://as.test/authorize");
    expect(url.searchParams.get("client_id")).toBe("app-1");
    expect(url.searchParams.get("scope")).toBe("mail.read");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("resource")).toBe(URL_);
    const stored = await store.get("mcp:mail");
    expect(stored?.value).toMatchObject({
      tokens: { access_token: "access-1", refresh_token: "refresh-1" },
    });
  });

  /**
   * @case A callback whose state does not match the request
   * @preconditions The browser returns a code with a forged state
   * @expectedResult The login fails with RC5003 and nothing is stored
   */
  test("refuses a callback with a forged state", async () => {
    server = oauthRemote(URL_);
    const store = new MemoryCredentialStore();
    let back: URLSearchParams | undefined;
    const io: CredentialLoginIO = {
      redirectUrl: "http://127.0.0.1:53682/callback",
      openUrl: async (url) => {
        back = server!.consent(url);
        back.set("state", "forged");
      },
      waitForCallback: async () => back!,
    };
    await expect(
      connectLogin("mail", URL_, connect({ clientId: "app-1" })).login(
        store,
        io,
      ),
    ).rejects.toMatchObject({ rc: "RC5003" });
    expect(await store.get("mcp:mail")).toBeUndefined();
  });

  /**
   * @case Extra authorization parameters and no resource indicator
   * @preconditions connect() with authorizationParams and resourceIndicator false
   * @expectedResult The authorization URL carries the extra parameters and no resource; the code exchange sends no resource either
   */
  test("adds authorization parameters and drops the resource", async () => {
    server = oauthRemote(URL_);
    const url = await login(
      new MemoryCredentialStore(),
      connect({
        clientId: "app-1",
        resourceIndicator: false,
        authorizationParams: { access_type: "offline", prompt: "consent" },
      }),
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.has("resource")).toBe(false);
    expect(server.tokenRequests.at(-1)?.has("resource")).toBe(false);
  });

  /**
   * @case An application calls a client with a stored credential
   * @preconditions mail logged in; the plugin bound with the store
   * @expectedResult The tool listing and a call succeed with the stored bearer token
   */
  test("calls with the stored credential", async () => {
    server = oauthRemote(URL_);
    const store = new MemoryCredentialStore();
    await login(store);
    const service = await start(store);
    expect(service.disabledClients.has("mail")).toBe(false);
    expect(await dispatchMcpCall(service, "mail", "echo", {})).toBe("pong");
  });

  /**
   * @case An expired access token is refreshed and the rotated tokens written back
   * @preconditions mail logged in at version 1; then every access token expires
   * @expectedResult The call succeeds after one refresh that repeats the configured scope, and the store holds the new refresh token at a higher version
   */
  test("refreshes and writes the rotated tokens back", async () => {
    server = oauthRemote(URL_);
    const store = new MemoryCredentialStore();
    await login(store);
    const service = await start(store);
    server.expireAccess();
    // A fresh connection, so the handshake meets the 401.
    server.remote.dropSessions();
    expect(await dispatchMcpCall(service, "mail", "echo", {})).toBe("pong");
    expect(server.counts.refreshed).toBe(1);
    const refresh = server.tokenRequests.at(-1);
    expect(refresh?.get("grant_type")).toBe("refresh_token");
    expect(refresh?.get("scope")).toBe("mail.read");
    const stored = await store.get("mcp:mail");
    expect(stored?.value).toMatchObject({
      tokens: { refresh_token: "refresh-2" },
    });
    expect(stored!.version).toBeGreaterThan(1);
  });

  /**
   * @case A second replica refreshes after the first rotated the refresh token
   * @preconditions Two applications share one store; the first refreshes (rotating the refresh token), then the second meets an expired access token
   * @expectedResult The second reads the rotated token from the store rather than spending the old one: no refresh is refused, its call succeeds, and the client stays enabled
   */
  test("a second replica recovers from a refresh the first spent", async () => {
    server = oauthRemote(URL_);
    const store = new MemoryCredentialStore();
    await login(store);
    const first = await start(store);
    const firstContext = t;
    t = undefined;
    try {
      const second = await start(store);
      // The second read the credential at bind; its first token read is
      // lazy, so make it hold version 1 by calling once.
      expect(await dispatchMcpCall(second, "mail", "echo", {})).toBe("pong");
      server.expireAccess();
      server.remote.dropSessions();
      expect(await dispatchMcpCall(first, "mail", "echo", {})).toBe("pong");
      server.expireAccess();
      expect(await dispatchMcpCall(second, "mail", "echo", {})).toBe("pong");
      expect(second.disabledClients.has("mail")).toBe(false);
      expect(server.counts).toMatchObject({ refreshed: 2, refused: 0 });
    } finally {
      await firstContext?.stop();
    }
  });

  /**
   * @case A refresh token the authorization server revoked
   * @preconditions mail logged in; access and refresh tokens both invalidated
   * @expectedResult The call fails with RC5003, the client is disabled with a reason naming craft connect, its tools are gone, and the store no longer holds the dead credential
   */
  test("a revoked credential disables the client", async () => {
    server = oauthRemote(URL_);
    const store = new MemoryCredentialStore();
    await login(store);
    const service = await start(store);
    expect(service.tools.getToolsByServer("mail").length).toBeGreaterThan(0);
    server.expireAccess();
    server.revokeRefresh();
    server.remote.dropSessions();
    await expect(
      dispatchMcpCall(service, "mail", "echo", {}),
    ).rejects.toMatchObject({ rc: "RC5003" });
    expect(service.disabledClients.get("mail")).toContain("craft connect mail");
    expect(service.tools.getToolsByServer("mail")).toEqual([]);
    expect(await store.get("mcp:mail")).toBeUndefined();
    await expect(
      dispatchMcpCall(service, "mail", "echo", {}),
    ).rejects.toMatchObject({
      rc: "RC5003",
      message: expect.stringContaining("disabled"),
    });
  });

  /**
   * @case A client that logs in, with nothing stored
   * @preconditions An empty store
   * @expectedResult The application starts; the client is disabled with a reason naming craft connect and no request reaches the server
   */
  test("no stored credential disables the client at bind", async () => {
    server = oauthRemote(URL_);
    const service = await start(new MemoryCredentialStore());
    expect(service.disabledClients.get("mail")).toContain("craft connect mail");
    expect(server.remote.counts.initialize).toBe(0);
  });

  /**
   * @case Concurrent calls meet an expired access token together
   * @preconditions mail logged in; five calls in flight on one connection when the access token expires; the authorization server rotates refresh tokens
   * @expectedResult One refresh reaches the authorization server, none is refused, and every call succeeds
   */
  test("concurrent 401s share one refresh", async () => {
    server = oauthRemote(URL_);
    const store = new MemoryCredentialStore();
    await login(store);
    const service = await start(store);
    server.expireAccess();
    const answers = await Promise.all(
      Array.from({ length: 5 }, () =>
        dispatchMcpCall(service, "mail", "echo", {}),
      ),
    );
    expect(answers).toEqual(["pong", "pong", "pong", "pong", "pong"]);
    expect(server.counts).toMatchObject({ refreshed: 1, refused: 0 });
  });

  /**
   * @case The authorization server is down when a refresh is needed
   * @preconditions mail logged in; the access token expired; the token endpoint answers 503 once
   * @expectedResult That call fails with RC5003 saying the server did not answer; the client stays enabled with its credential, and the next call refreshes and succeeds
   */
  test("a token endpoint outage does not disable the client", async () => {
    server = oauthRemote(URL_);
    const store = new MemoryCredentialStore();
    await login(store);
    const service = await start(store);
    server.expireAccess();
    server.tokenEndpointDown();
    await expect(
      dispatchMcpCall(service, "mail", "echo", {}),
    ).rejects.toMatchObject({ rc: "RC5003" });
    expect(service.disabledClients.has("mail")).toBe(false);
    expect(await store.get("mcp:mail")).toBeDefined();
    expect(await dispatchMcpCall(service, "mail", "echo", {})).toBe("pong");
  });

  /**
   * @case A stored value that is not a credential
   * @preconditions mcp:mail holds { foo: 1 }, as a damaged seed or a foreign build could leave
   * @expectedResult The first call fails with RC5003 and the client is disabled with a reason saying the credential cannot be read
   */
  test("a malformed stored credential disables the client", async () => {
    server = oauthRemote(URL_);
    const store = new MemoryCredentialStore();
    await store.put("mcp:mail", { foo: 1 }, { ifVersion: null });
    const service = await start(store);
    await expect(
      dispatchMcpCall(service, "mail", "echo", {}),
    ).rejects.toMatchObject({ rc: "RC5003" });
    expect(service.disabledClients.get("mail")).toContain(
      "not one this build can read",
    );
  });

  /**
   * @case craft connect finds the clients declared with connect()
   * @preconditions One under the mcp key, one in an mcpPlugin() in plugins, one in a spread mcpPlugin(), and one with a static token
   * @expectedResult The three connect() clients are collected under their names; the static one is not
   */
  test("the login collector reads both config forms", () => {
    const auth = connect({ clientId: "app-1" });
    const ids = collectCredentialLogins({
      mcp: {
        clients: {
          a: { url: URL_, auth },
          plain: { url: URL_, auth: { token: "t" } },
        },
      },
      plugins: [
        mcpPlugin({ clients: { b: { url: URL_, auth } } }),
        { ...mcpPlugin({ clients: { c: { url: URL_, auth } } }) },
      ],
    }).map((login) => `${login.id}=${login.owner}`);
    expect(ids).toEqual(["a=mcp:a", "b=mcp:b", "c=mcp:c"]);
  });

  /**
   * @case connect() without a client id
   * @preconditions clientId is an empty string
   * @expectedResult connect() throws RC5003
   */
  test("connect() requires a client id", () => {
    expect(() => connect({ clientId: " " })).toThrow(
      expect.objectContaining({ rc: "RC5003" }),
    );
  });

  /**
   * @case connect() options that would weaken the login
   * @preconditions authorizationParams naming state or redirect_uri; an http authorization server on a remote host
   * @expectedResult Each throws RC5003; extra parameters the flow does not own, and http on loopback, are accepted
   */
  test("connect() refuses options that would weaken the login", () => {
    for (const name of ["state", "redirect_uri", "code_challenge", "scope"]) {
      expect(() =>
        connect({ clientId: "a", authorizationParams: { [name]: "x" } }),
      ).toThrow(expect.objectContaining({ rc: "RC5003" }));
    }
    expect(() =>
      connect({ clientId: "a", authorizationServer: "http://as.example" }),
    ).toThrow(expect.objectContaining({ rc: "RC5003" }));
    expect(() =>
      connect({
        clientId: "a",
        authorizationServer: "http://127.0.0.1:9000",
        authorizationParams: { access_type: "offline", prompt: "consent" },
      }),
    ).not.toThrow();
  });
});
