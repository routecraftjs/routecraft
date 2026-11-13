/**
 * Optional-peer loaders for the MCP TypeScript SDK v2.
 *
 * The v1 SDK shipped as a single `@modelcontextprotocol/sdk` package with deep
 * sub-path imports (`/server/index.js`, `/client/streamableHttp.js`, ...). v2
 * splits it into role packages with flat entry points, so every load site
 * resolves through a helper here rather than restating the `loadOptionalPeer`
 * incantation with its own package name and adapter label.
 *
 * Centralising the loads also keeps the install hints correct: a consumer using
 * only outbound MCP clients is told to install `@modelcontextprotocol/client`,
 * not the whole SDK.
 *
 * @see https://modelcontextprotocol.io/specification/2026-07-28
 */
import { loadOptionalPeer, rcError } from "@routecraft/routecraft";
import { version as packageVersion } from "../../package.json";
import { buildAuthHeaders } from "./build-auth-headers.ts";
import type { AuthProvider } from "@modelcontextprotocol/client";
import type { McpClientAuthOptions } from "./types.ts";

/** The v2 server package: `createMcpHandler`, `Server`, bearer auth, OAuth metadata. */
export function loadMcpServerSdk(
  consumer: string,
): Promise<typeof import("@modelcontextprotocol/server")> {
  return loadOptionalPeer(() => import("@modelcontextprotocol/server"), {
    consumer,
    packageName: "@modelcontextprotocol/server",
  });
}

/** The v2 server stdio entry: `serveStdio`. */
export function loadMcpServerStdioSdk(
  consumer: string,
): Promise<typeof import("@modelcontextprotocol/server/stdio")> {
  return loadOptionalPeer(() => import("@modelcontextprotocol/server/stdio"), {
    consumer,
    packageName: "@modelcontextprotocol/server",
  });
}

/** The v2 Node adapter: `toNodeHandler` bridges a web-standard handler to `node:http`. */
export function loadMcpNodeSdk(
  consumer: string,
): Promise<typeof import("@modelcontextprotocol/node")> {
  return loadOptionalPeer(() => import("@modelcontextprotocol/node"), {
    consumer,
    packageName: "@modelcontextprotocol/node",
  });
}

/** The v2 client package: `Client`, `StreamableHTTPClientTransport`. */
export function loadMcpClientSdk(
  consumer: string,
): Promise<typeof import("@modelcontextprotocol/client")> {
  return loadOptionalPeer(() => import("@modelcontextprotocol/client"), {
    consumer,
    packageName: "@modelcontextprotocol/client",
  });
}

/** The v2 client stdio entry: `StdioClientTransport`. */
export function loadMcpClientStdioSdk(
  consumer: string,
): Promise<typeof import("@modelcontextprotocol/client/stdio")> {
  return loadOptionalPeer(() => import("@modelcontextprotocol/client/stdio"), {
    consumer,
    packageName: "@modelcontextprotocol/client",
  });
}

/**
 * Protocol negotiation applied to every outbound Routecraft MCP client.
 *
 * `auto` probes with `server/discover` and speaks the 2026-07-28 stateless
 * revision when the remote offers it, falling back to the 2025 `initialize`
 * handshake otherwise. Routecraft cannot know which revision a configured
 * remote speaks, so pinning either era would strand half the ecosystem.
 */
export const MCP_VERSION_NEGOTIATION = {
  mode: "auto",
} as const;

/**
 * Client identity Routecraft presents on every outbound MCP connection.
 *
 * The version is the real package version, not a constant: remote servers log
 * and branch on `clientInfo.version`, so a frozen value would make every
 * Routecraft client indistinguishable in their telemetry.
 */
export const MCP_CLIENT_INFO = {
  name: "routecraft-mcp-client",
  version: packageVersion,
} as const;

/**
 * Refuse a remote MCP URL that is not https. Plain http is accepted for a
 * loopback host, and for any host when the client says `allowHttp`: the
 * credential and every tool argument travel to this server.
 *
 * @throws RC5003
 * @internal
 */
export function assertRemoteUrl(
  value: string | URL,
  allowHttp: boolean,
  field: string,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw rcError("RC5003", undefined, {
      message: `${field} must be an absolute http(s) URL.`,
    });
  }
  if (url.protocol === "https:") return url;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && (loopback || allowHttp)) return url;
  throw rcError("RC5003", undefined, {
    message: `${field} must be an https URL: the credential and the tool arguments are sent to it.`,
    suggestion:
      url.protocol === "http:"
        ? "Use https, or set allowHttp: true on the client for a host on a private network."
        : "Use an https URL. A stdio server is registered with { transport: 'stdio', command }.",
  });
}

/**
 * A `fetch` that answers a redirect with an error instead of following it.
 * A remote that redirects would otherwise receive the request, its custom
 * auth headers included, at a host nobody configured.
 */
function refusingRedirects(
  send: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const response = await send(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      throw rcError("RC5003", undefined, {
        message: `mcp: the remote server answered with a redirect (${response.status}${location === null ? "" : ` to "${location}"`}), which is not followed.`,
        suggestion:
          "Configure the client with the URL the server redirects to, after checking it is the server you mean.",
      });
    }
    return response;
  };
}

/**
 * Open one outbound MCP client over Streamable HTTP.
 *
 * Every caller that talks to a remote MCP server over HTTP goes through here,
 * so negotiation mode, client identity and auth headers cannot drift between
 * the one-shot dispatch path and the plugin's cached clients. A failed
 * handshake closes the transport rather than orphaning its socket.
 *
 * The stdio manager deliberately does not use this: it builds a stdio
 * transport and registers a `listChanged` handler, and folding both shapes
 * into one helper would need a transport-kind flag. It shares the loaders and
 * constants above instead.
 */
export async function connectMcpHttpClient(
  url: URL,
  auth?: McpClientAuthOptions,
  authProvider?: AuthProvider,
  allowHttp = false,
): Promise<{
  client: InstanceType<Awaited<ReturnType<typeof loadMcpClientSdk>>["Client"]>;
  transport: InstanceType<
    Awaited<
      ReturnType<typeof loadMcpClientSdk>
    >["StreamableHTTPClientTransport"]
  >;
}> {
  assertRemoteUrl(url, allowHttp, "mcp: the client url");
  const { Client, StreamableHTTPClientTransport } =
    await loadMcpClientSdk("mcp (http client)");

  // Auth headers are resolved per request through the transport's fetch hook,
  // not baked into `requestInit` once at connect. `McpClientTokenProvider` is
  // documented as "called on every request", and a token array round-robins
  // per request; a client cached across many calls (mcpPlugin's clients) would
  // otherwise pin whichever token was current when it connected and keep
  // presenting it after expiry.
  //
  // An OAuth provider takes the place of the hook: the transport asks it for
  // the access token on every request and has it refresh on a 401.
  const transport = new StreamableHTTPClientTransport(
    url,
    authProvider
      ? { authProvider, fetch: refusingRedirects(fetch) }
      : {
          fetch: refusingRedirects(async (input, init) => {
            const headers = await buildAuthHeaders(auth);
            if (!headers) return fetch(input, init);
            const merged = new Headers(init?.headers);
            for (const [name, value] of Object.entries(headers)) {
              merged.set(name, value);
            }
            return fetch(input, { ...init, headers: merged });
          }),
        },
  );
  const client = new Client(MCP_CLIENT_INFO, {
    capabilities: {},
    versionNegotiation: MCP_VERSION_NEGOTIATION,
  });

  try {
    await client.connect(transport);
  } catch (cause) {
    await transport.close().catch(() => {});
    throw cause;
  }

  return { client, transport };
}
