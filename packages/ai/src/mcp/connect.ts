import { randomBytes } from "node:crypto";
import {
  rcError,
  type CredentialLogin,
  type CredentialStore,
} from "@routecraft/routecraft";
import type {
  AuthProvider,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { loadMcpClientSdk } from "./sdk.ts";

/** Brands a {@link connect} declaration, so it is told apart from `{ token }`. */
const CONNECT = Symbol.for("routecraft.ai.mcp.connect");

/** How a named MCP client obtains its credential with {@link connect}. */
export interface McpConnectOptions {
  /**
   * The OAuth client id registered with the authorization server. Required:
   * an authorization server that offers dynamic client registration is not
   * relied on, because the providers this targets first offer none.
   */
  clientId: string;
  /**
   * The client secret, for an authorization server that issues one even to
   * an app that runs on the user's machine. Sent in the token request body.
   */
  clientSecret?: string;
  /**
   * Scopes to request at login. Ask for the narrowest the server allows:
   * every caller a route admits acts with this credential's authority.
   */
  scopes?: readonly string[];
  /**
   * The authorization server's issuer URL, for an MCP server that does not
   * advertise one (RFC 9728 protected resource metadata). Discovered from
   * the MCP server when unset.
   */
  authorizationServer?: string;
  /**
   * Whether to send the RFC 8707 `resource` parameter naming the MCP
   * server. Default `true`. Turn it off for an authorization server that
   * rejects the parameter and scopes its tokens by `scopes` alone.
   */
  resourceIndicator?: boolean;
  /**
   * Extra query parameters on the authorization request, for a server that
   * issues a refresh token only when asked in its own terms (for example
   * `{ access_type: "offline", prompt: "consent" }`). Without a refresh
   * token the credential lasts until the first access token expires.
   */
  authorizationParams?: Readonly<Record<string, string>>;
}

/** A {@link connect} declaration, as `auth` on a named HTTP client. */
export interface McpConnectAuth {
  readonly [CONNECT]: true;
  readonly options: Readonly<McpConnectOptions>;
}

/**
 * Declare that a named MCP client logs in with OAuth (authorization code
 * with PKCE) and keeps its credential in the credential store.
 *
 * A person logs in once with `craft connect <client>`; the application
 * reads the stored credential, refreshes it when it expires, and writes the
 * refreshed one back. A server gets its credential from a seed the login
 * exported (`craft connect <client> --export`). A client with no stored
 * credential, or whose refresh is refused, is disabled with the reason, and
 * the rest of the application runs.
 *
 * Only on `mcpPlugin({ clients })`: an inline `mcp({ url })` has no name to
 * keep a credential under.
 *
 * @example
 * ```ts
 * mcpPlugin({
 *   clients: {
 *     mail: {
 *       url: env.MAIL_MCP_URL,
 *       auth: connect({ clientId: env.MAIL_CLIENT_ID, scopes: ["mail.read"] }),
 *     },
 *   },
 * });
 * ```
 */
export function connect(options: McpConnectOptions): McpConnectAuth {
  if (typeof options?.clientId !== "string" || options.clientId.trim() === "") {
    throw rcError("RC5003", undefined, {
      message:
        "connect() needs a clientId: the OAuth client id registered with the authorization server.",
    });
  }
  if (options.authorizationServer !== undefined) {
    assertUrl(options.authorizationServer, "connect({ authorizationServer })");
  }
  return Object.freeze({
    [CONNECT]: true as const,
    options: Object.freeze({
      ...options,
      ...(options.scopes ? { scopes: Object.freeze([...options.scopes]) } : {}),
    }),
  });
}

/** Whether `auth` is a {@link connect} declaration. */
export function isConnectAuth(auth: unknown): auth is McpConnectAuth {
  return (
    typeof auth === "object" &&
    auth !== null &&
    (auth as Record<symbol, unknown>)[CONNECT] === true
  );
}

/** The store owner a named client's credential is kept under. */
export function connectOwner(serverId: string): string {
  return `mcp:${serverId}`;
}

/** The command that obtains a client's credential, for messages. */
export function connectHint(serverId: string): string {
  return `run \`craft connect ${serverId}\``;
}

/** What a client's credential record holds. */
export interface ConnectCredential {
  readonly tokens: StoredOAuthTokens;
  /** Where the tokens came from, so a later refresh skips rediscovery. */
  readonly discovery?: OAuthDiscoveryState;
}

/**
 * The stored value as a {@link ConnectCredential}, or `undefined` when it
 * is not one: a seed, a custom store or another build can hand back
 * anything, and only this module knows the shape.
 */
function asConnectCredential(value: unknown): ConnectCredential | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const tokens = (value as { tokens?: unknown }).tokens;
  if (typeof tokens !== "object" || tokens === null) return undefined;
  return typeof (tokens as { access_token?: unknown }).access_token === "string"
    ? (value as ConnectCredential)
    : undefined;
}

/** Callbacks an {@link StoreOAuthProvider} reports through. */
export interface StoreOAuthProviderOptions {
  readonly serverId: string;
  readonly options: Readonly<McpConnectOptions>;
  readonly store: CredentialStore;
  /**
   * Set for a login: where the authorization server redirects, and what to
   * do with the URL the person must open. Unset for an application, which
   * never opens a browser: a refresh that fails reports through
   * {@link onLoginRequired} instead.
   */
  readonly login?: {
    readonly redirectUrl: string;
    readonly onAuthorizationUrl: (url: URL) => void | Promise<void>;
  };
  /** The stored credential is missing, revoked or refused a refresh. */
  readonly onLoginRequired?: (reason: string) => void;
}

/**
 * The MCP SDK's OAuth client hooks over the credential store.
 *
 * The SDK runs discovery, PKCE, the code exchange and refresh; this class
 * only says where things are kept. Tokens live in the store under the
 * client's owner. Every write is a compare-and-swap against the version the
 * tokens were read at, so two replicas refreshing at once cannot both spend
 * a refresh token that rotates: the loser's write is refused and its next
 * read finds the winner's.
 *
 * @internal
 */
export class StoreOAuthProvider implements OAuthClientProvider {
  readonly #config: StoreOAuthProviderOptions;
  readonly #owner: string;
  /** The store version the current tokens were read at. */
  #version: number | null = null;
  /**
   * The version the SDK's last auth run read, as opposed to a per-request
   * token read: a refused refresh deletes only that record.
   */
  #refreshFrom: number | null = null;
  #discovery: OAuthDiscoveryState | undefined;
  #codeVerifier: string | undefined;
  #state: string | undefined;

  constructor(config: StoreOAuthProviderOptions) {
    this.#config = config;
    this.#owner = connectOwner(config.serverId);
    this.#discovery = this.#configuredDiscovery();
    if (config.options.resourceIndicator === false) {
      // Defined only when off: the SDK treats the hook's presence as a
      // say over the parameter, and its absence as the default.
      this.validateResourceURL = async () => undefined;
    }
  }

  validateResourceURL?: (
    serverUrl: string | URL,
    resource?: string,
  ) => Promise<URL | undefined>;

  /**
   * A login's loopback address. An application has none, and still answers
   * one: without a redirect URL the SDK treats the client as a machine
   * client and tries a client-credentials grant, which no user-delegated
   * client is allowed. With one, a refused refresh ends in
   * {@link redirectToAuthorization}, which disables the client.
   */
  get redirectUrl(): string {
    return this.#config.login?.redirectUrl ?? "http://127.0.0.1/callback";
  }

  get clientMetadata(): OAuthClientMetadata {
    const { scopes, clientSecret } = this.#config.options;
    return {
      client_name: "Routecraft",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method:
        clientSecret === undefined ? "none" : "client_secret_post",
      ...(scopes && scopes.length > 0 ? { scope: scopes.join(" ") } : {}),
    };
  }

  state(): string {
    this.#state = randomBytes(16).toString("base64url");
    return this.#state;
  }

  /** The state the authorization request carried, for the callback to check. */
  get expectedState(): string | undefined {
    return this.#state;
  }

  clientInformation(): StoredOAuthClientInformation {
    const { clientId, clientSecret } = this.#config.options;
    return {
      client_id: clientId,
      ...(clientSecret !== undefined ? { client_secret: clientSecret } : {}),
    };
  }

  /**
   * @param ctx - Present when the SDK reads for an auth run (a refresh),
   *   absent on the transport's per-request read
   */
  async tokens(ctx?: object): Promise<StoredOAuthTokens | undefined> {
    // A login starts from nothing: offered stored tokens, the SDK would
    // refresh them instead of asking the person to log in again.
    if (this.#config.login && this.#version === null) return undefined;
    const stored = await this.#config.store.get(this.#owner);
    const credential = asConnectCredential(stored?.value);
    if (stored === undefined || credential === undefined) {
      this.#version = null;
      if (ctx !== undefined) this.#refreshFrom = null;
      return undefined;
    }
    this.#version = stored.version;
    if (ctx !== undefined) this.#refreshFrom = stored.version;
    if (this.#discovery === undefined && credential.discovery !== undefined) {
      this.#discovery = credential.discovery;
    }
    return credential.tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    const credential: ConnectCredential = {
      tokens,
      ...(this.#discovery !== undefined ? { discovery: this.#discovery } : {}),
    };
    if (this.#config.login) {
      // A login replaces whatever was there, and starts a new issue time.
      const current = await this.#config.store.get(this.#owner);
      const write = await this.#config.store.put(this.#owner, credential, {
        ifVersion: current?.version ?? null,
        issuedAt: Date.now(),
      });
      if (!write.written) {
        throw rcError("RC5070", undefined, {
          message: `The credential of MCP client "${this.#config.serverId}" changed while logging in; run the login again.`,
        });
      }
      this.#version = write.version;
      return;
    }
    const write = await this.#config.store.put(this.#owner, credential, {
      ifVersion: this.#version,
    });
    // Refused: another process refreshed first and stored its own tokens.
    // These are valid for this request; the next read takes the stored ones.
    this.#version = write.written
      ? write.version
      : (write.current?.version ?? null);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.#config.login) {
      const extra = this.#config.options.authorizationParams ?? {};
      for (const [name, value] of Object.entries(extra)) {
        authorizationUrl.searchParams.set(name, value);
      }
      await this.#config.login.onAuthorizationUrl(authorizationUrl);
      return;
    }
    // Reached when the stored credential cannot be used, and also when the
    // authorization server could not be reached or answered a server error:
    // the SDK falls through to a new authorization either way. Only the
    // first disables; a credential still holding a refresh token is kept
    // for the next call to try again.
    const stored = await this.#config.store.get(this.#owner);
    const held = asConnectCredential(stored?.value);
    if (held?.tokens.refresh_token !== undefined) {
      throw rcError("RC5003", undefined, {
        message: `MCP client "${this.#config.serverId}" could not refresh its credential: the authorization server did not answer. The next call tries again.`,
      });
    }
    const reason =
      stored !== undefined && held === undefined
        ? `its stored credential is not one this build can read; ${connectHint(this.#config.serverId)}`
        : `its stored credential was refused or has no refresh token; ${connectHint(this.#config.serverId)}`;
    this.#config.onLoginRequired?.(reason);
    throw rcError("RC5003", undefined, {
      message: `MCP client "${this.#config.serverId}" needs a login: ${reason}.`,
    });
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.#codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (this.#codeVerifier === undefined) {
      throw rcError("RC5003", undefined, {
        message: `MCP client "${this.#config.serverId}": no login is in progress.`,
      });
    }
    return this.#codeVerifier;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "verifier" || scope === "all") this.#codeVerifier = undefined;
    if (scope === "discovery" || scope === "all") {
      this.#discovery = this.#configuredDiscovery();
    }
    if ((scope === "tokens" || scope === "all") && !this.#config.login) {
      // Only the record the refused refresh read: when another replica
      // refreshed meanwhile, its credential is newer than the one refused.
      if (this.#refreshFrom !== null) {
        await this.#config.store.delete(this.#owner, {
          ifVersion: this.#refreshFrom,
        });
      }
      this.#refreshFrom = null;
      this.#version = null;
    }
    // "client": the client id is configuration, not something to forget.
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.#discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#discovery;
  }

  /** The discovery state configuration pins, before any discovery runs. */
  #configuredDiscovery(): OAuthDiscoveryState | undefined {
    const server = this.#config.options.authorizationServer;
    return server === undefined
      ? undefined
      : { authorizationServerUrl: server };
  }
}

/**
 * The transport's view of a {@link StoreOAuthProvider}: the stored access
 * token on every request, and one refresh at a time on a 401.
 *
 * The SDK starts an auth run per 401, so calls sharing a connection that
 * meet an expired token together would each present the same refresh
 * token. Where the authorization server rotates refresh tokens, every run
 * after the first is refused, and one that detects reuse revokes the whole
 * grant. Concurrent 401s therefore wait on the run already in flight.
 *
 * @internal
 */
export function coalescedAuthProvider(
  provider: StoreOAuthProvider,
): AuthProvider {
  let inFlight: Promise<void> | undefined;
  return {
    token: async () => (await provider.tokens())?.access_token,
    onUnauthorized(ctx) {
      inFlight ??= (async () => {
        const sdk = await loadMcpClientSdk("mcp (http client)");
        const { resourceMetadataUrl, scope } = sdk.extractWWWAuthenticateParams(
          ctx.response,
        );
        const result = await sdk.auth(provider, {
          serverUrl: ctx.serverUrl,
          fetchFn: ctx.fetchFn,
          ...(resourceMetadataUrl !== undefined ? { resourceMetadataUrl } : {}),
          ...(scope !== undefined ? { scope } : {}),
        });
        if (result !== "AUTHORIZED") throw new sdk.UnauthorizedError();
      })().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}

/**
 * The login `craft connect <serverId>` runs for a client declared with
 * {@link connect}: the authorization code flow with PKCE, through the
 * person's browser, ending with the credential in the store.
 *
 * @internal
 */
export function connectLogin(
  serverId: string,
  url: string,
  auth: McpConnectAuth,
): CredentialLogin {
  return {
    id: serverId,
    owner: connectOwner(serverId),
    description: url,
    async login(store, io) {
      const sdk = await loadMcpClientSdk("craft connect");
      const provider = new StoreOAuthProvider({
        serverId,
        options: auth.options,
        store,
        login: {
          redirectUrl: io.redirectUrl,
          onAuthorizationUrl: (authorizationUrl) =>
            io.openUrl(authorizationUrl),
        },
      });
      const serverUrl = new URL(url);
      if ((await sdk.auth(provider, { serverUrl })) === "AUTHORIZED") return;
      const callback = await io.waitForCallback();
      const refused = callback.get("error");
      if (refused !== null) {
        const detail = callback.get("error_description");
        throw rcError("RC5003", undefined, {
          message: `The login to MCP client "${serverId}" was refused: ${refused}${detail ? ` (${detail})` : ""}.`,
        });
      }
      // The state ties the redirect to the request this process made, so
      // a redirect forged at the loopback port cannot plant its own code.
      if (callback.get("state") !== provider.expectedState) {
        throw rcError("RC5003", undefined, {
          message: `The login to MCP client "${serverId}" came back with a state this login did not send; run it again.`,
        });
      }
      const authorizationCode = callback.get("code");
      if (authorizationCode === null) {
        throw rcError("RC5003", undefined, {
          message: `The login to MCP client "${serverId}" came back without an authorization code.`,
        });
      }
      const iss = callback.get("iss");
      await sdk.auth(provider, {
        serverUrl,
        authorizationCode,
        ...(iss !== null ? { iss } : {}),
      });
    },
  };
}

function assertUrl(value: string, field: string): void {
  try {
    new URL(value);
  } catch {
    throw rcError("RC5003", undefined, {
      message: `${field} must be an absolute URL, got "${value}".`,
    });
  }
}
