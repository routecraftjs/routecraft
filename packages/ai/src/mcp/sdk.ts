/**
 * Optional-peer loaders for the MCP TypeScript SDK v2.
 *
 * The v1 SDK shipped as a single `@modelcontextprotocol/sdk` package with deep
 * sub-path imports (`/server/index.js`, `/client/streamableHttp.js`, ...). v2
 * splits it into role packages with flat entry points, so every load site
 * resolves through one of the four helpers here rather than restating the
 * `loadOptionalPeer` incantation with its own package name and adapter label.
 *
 * Centralising the loads also keeps the install hints correct: a consumer using
 * only outbound MCP clients is told to install `@modelcontextprotocol/client`,
 * not the whole SDK.
 *
 * @see https://modelcontextprotocol.io/specification/2026-07-28
 */
import { loadOptionalPeer } from "@routecraft/routecraft";

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

/**
 * The v2 legacy auth package: `mcpAuthRouter`, `ProxyOAuthServerProvider`.
 *
 * v2 moved the OAuth *authorization server* surface out of the main server
 * package on the reasoning that an MCP server should delegate to a dedicated
 * IdP rather than proxy one. Routecraft's `oauth()` mode is exactly that proxy,
 * so it keeps working from here. Resource-server duties (bearer verification,
 * RFC 9728 metadata) come from `@modelcontextprotocol/server` on both auth
 * paths and do not touch this package.
 *
 * @deprecated Tracks the SDK's own deprecation of the AS-proxy surface.
 */
export function loadMcpLegacyAuthSdk(
  adapterName: string,
): Promise<typeof import("@modelcontextprotocol/server-legacy/auth")> {
  return loadOptionalPeer(
    () => import("@modelcontextprotocol/server-legacy/auth"),
    { adapterName, packageName: "@modelcontextprotocol/server-legacy" },
  );
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

/** Client identity Routecraft presents on every outbound MCP connection. */
export const MCP_CLIENT_INFO = {
  name: "routecraft-mcp-client",
  version: "1.0.0",
} as const;
