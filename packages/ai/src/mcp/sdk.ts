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
import { loadOptionalPeer } from "@routecraft/routecraft";
import { version as packageVersion } from "../../package.json";
import { buildAuthHeaders } from "./build-auth-headers.ts";
import type { McpClientAuthOptions } from "./types.ts";

/** The v2 server package: `createMcpHandler`, `Server`, bearer auth, OAuth metadata. */
export function loadMcpServerSdk(
  adapterName: string,
): Promise<typeof import("@modelcontextprotocol/server")> {
  return loadOptionalPeer(() => import("@modelcontextprotocol/server"), {
    adapterName,
    packageName: "@modelcontextprotocol/server",
  });
}

/** The v2 server stdio entry: `serveStdio`. */
export function loadMcpServerStdioSdk(
  adapterName: string,
): Promise<typeof import("@modelcontextprotocol/server/stdio")> {
  return loadOptionalPeer(() => import("@modelcontextprotocol/server/stdio"), {
    adapterName,
    packageName: "@modelcontextprotocol/server",
  });
}

/** The v2 Node adapter: `toNodeHandler` bridges a web-standard handler to `node:http`. */
export function loadMcpNodeSdk(
  adapterName: string,
): Promise<typeof import("@modelcontextprotocol/node")> {
  return loadOptionalPeer(() => import("@modelcontextprotocol/node"), {
    adapterName,
    packageName: "@modelcontextprotocol/node",
  });
}

/** The v2 client package: `Client`, `StreamableHTTPClientTransport`. */
export function loadMcpClientSdk(
  adapterName: string,
): Promise<typeof import("@modelcontextprotocol/client")> {
  return loadOptionalPeer(() => import("@modelcontextprotocol/client"), {
    adapterName,
    packageName: "@modelcontextprotocol/client",
  });
}

/** The v2 client stdio entry: `StdioClientTransport`. */
export function loadMcpClientStdioSdk(
  adapterName: string,
): Promise<typeof import("@modelcontextprotocol/client/stdio")> {
  return loadOptionalPeer(() => import("@modelcontextprotocol/client/stdio"), {
    adapterName,
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
): Promise<{
  client: InstanceType<Awaited<ReturnType<typeof loadMcpClientSdk>>["Client"]>;
  transport: InstanceType<
    Awaited<
      ReturnType<typeof loadMcpClientSdk>
    >["StreamableHTTPClientTransport"]
  >;
}> {
  const { Client, StreamableHTTPClientTransport } =
    await loadMcpClientSdk("mcp (http client)");

  // Auth headers are resolved per request through the transport's fetch hook,
  // not baked into `requestInit` once at connect. `McpClientTokenProvider` is
  // documented as "called on every request", and a token array round-robins
  // per request; a client cached across many calls (mcpPlugin's clients) would
  // otherwise pin whichever token was current when it connected and keep
  // presenting it after expiry.
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: async (input, init) => {
      const headers = await buildAuthHeaders(auth);
      if (!headers) return fetch(input, init);
      const merged = new Headers(init?.headers);
      for (const [name, value] of Object.entries(headers)) {
        merged.set(name, value);
      }
      return fetch(input, { ...init, headers: merged });
    },
  });
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
