import { rcError } from "@routecraft/routecraft";
import {
  createConnectionCache,
  type DisposableEntry,
} from "./http-client-cache.ts";
import { connectMcpHttpClient, loadMcpClientSdk } from "./sdk.ts";
import type {
  McpClientHttpConfig,
  McpRawToolResult,
  McpTool,
} from "./types.ts";

/** What one cached connection can do: the two requests the plugin makes. */
interface HttpConnection extends DisposableEntry {
  listTools(): Promise<{ tools: McpTool[] }>;
  callTool(params: {
    name: string;
    arguments: Record<string, unknown>;
    _meta?: Record<string, string>;
  }): Promise<McpRawToolResult>;
  /** The session the remote assigned at the handshake, when it is stateful. */
  readonly sessionId: string | undefined;
}

/**
 * The long-lived connections to the registered HTTP clients, one per client
 * id, shared by the tool listing and every call. Opening a connection is a
 * handshake, and a stateful remote ties its session to it, so a call that
 * opened its own connection paid the handshake every time and never saw the
 * session the listing had.
 *
 * @internal
 */
export interface McpHttpConnections {
  /** List a registered client's tools on its connection. */
  listTools(
    serverId: string,
    config: McpClientHttpConfig,
  ): Promise<{ tools: McpTool[] }>;
  /** Call a registered client's tool on its connection. */
  callTool(
    serverId: string,
    config: McpClientHttpConfig,
    toolName: string,
    args: Record<string, unknown>,
    meta?: Record<string, string>,
  ): Promise<McpRawToolResult>;
  /**
   * Close every connection, and refuse to open another, so a call that
   * arrives during teardown cannot leave a socket nobody closes.
   */
  disposeAll(
    onError: (error: unknown, serverId: string) => void,
  ): Promise<void>;
}

/**
 * The connections over a connection cache keyed by client id.
 *
 * A failure evicts the connection unless the remote answered it: a JSON-RPC
 * error is the remote speaking over a healthy connection, while anything
 * else (a refused socket, an HTTP error status, a timeout) leaves the
 * connection in doubt. The failed request is reported, never resent, because
 * it may have reached the remote. A stale session is the one exception: a
 * remote that answers 404 to a request carrying its `Mcp-Session-Id` has
 * dropped the session and never processed the request, so the connection is
 * replaced and the request sent once more. A second 404 is a failure.
 *
 * @internal
 */
export function createMcpHttpConnections(): McpHttpConnections {
  const cache = createConnectionCache<HttpConnection>();
  let disposed = false;

  function connect(
    serverId: string,
    config: McpClientHttpConfig,
  ): Promise<HttpConnection> {
    if (disposed) {
      return Promise.reject(
        rcError("RC5003", undefined, {
          message: `mcp dispatch: client "${serverId}" was called after the MCP plugin stopped.`,
        }),
      );
    }
    return cache.getOrCreate(serverId, async () => {
      const { client, transport } = await connectMcpHttpClient(
        new URL(config.url),
        config.auth,
      );
      // Both handles are retained: closing the client does not close its
      // transport, so a cache that kept only the client would leak a socket
      // per entry on teardown and per eviction.
      return {
        listTools: () => client.listTools() as Promise<{ tools: McpTool[] }>,
        callTool: (params) =>
          client.callTool(params) as Promise<McpRawToolResult>,
        get sessionId() {
          return transport.sessionId;
        },
        dispose: async () => {
          await client.close().catch(() => undefined);
          await transport.close().catch(() => undefined);
        },
      };
    });
  }

  async function use<T>(
    serverId: string,
    config: McpClientHttpConfig,
    request: (connection: HttpConnection) => Promise<T>,
    resent = false,
  ): Promise<T> {
    const pending = connect(serverId, config);
    // A failed handshake evicts itself inside the cache.
    const connection = await pending;
    const sessionId = connection.sessionId;
    try {
      return await request(connection);
    } catch (error) {
      if (await answeredByRemote(error)) throw error;
      await cache.evict(serverId, pending);
      if (!resent && sessionId !== undefined && isNotFound(error)) {
        return use(serverId, config, request, true);
      }
      throw error;
    }
  }

  return {
    listTools: (serverId, config) =>
      use(serverId, config, (connection) => connection.listTools()),
    callTool: (serverId, config, toolName, args, meta) =>
      use(serverId, config, (connection) =>
        connection.callTool({
          name: toolName,
          arguments: args,
          ...(meta !== undefined ? { _meta: meta } : {}),
        }),
      ),
    async disposeAll(onError) {
      disposed = true;
      await cache.disposeAll(onError);
    },
  };
}

/** Whether the remote answered the request with a JSON-RPC error. */
async function answeredByRemote(error: unknown): Promise<boolean> {
  // The SDK is already loaded: a connection exists only once it was.
  const { ProtocolError } = await loadMcpClientSdk("mcp (http client)");
  return error instanceof ProtocolError;
}

/** Whether the transport failed on an HTTP 404. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 404
  );
}
