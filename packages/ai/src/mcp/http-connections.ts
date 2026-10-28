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
 * A failure the remote did not answer (a refused socket, a dropped stream,
 * a timeout) evicts the connection, so the next call reconnects. An answer
 * keeps it: a JSON-RPC error or an HTTP error status is the remote speaking
 * over a session that still holds, and Streamable HTTP requests are
 * independent, so one refused request says nothing about the next. Either
 * way the failed request is reported, never resent, because it may have
 * reached the remote.
 *
 * A stale session is the one exception: a remote that answers 404 to a
 * request carrying its `Mcp-Session-Id` has dropped the session and never
 * processed the request, so the connection is replaced and the request sent
 * once more. A second 404 is a failure.
 *
 * An evicted connection leaves the cache at once and closes once the
 * requests already on it have settled. Closing it under them would fail
 * calls the remote may already be running, and a caller that retries such
 * a failure would run them twice.
 *
 * @internal
 */
export function createMcpHttpConnections(): McpHttpConnections {
  const cache = createConnectionCache<HttpConnection>();
  // Every connection not yet closed, draining ones included, so stopping
  // the plugin closes them all whatever is still in flight.
  const open = new Set<() => Promise<void>>();
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
      let inFlight = 0;
      let retired = false;
      let closed: Promise<void> | undefined;
      // Ends the session on the remote before closing, so a stateful remote
      // is not left holding one per eviction. Bounded, because an
      // unreachable remote must not hold up the plugin's stop. Closing the
      // client closes its transport.
      const close = (): Promise<void> => {
        closed ??= (async () => {
          open.delete(close);
          await bounded(transport.terminateSession(), TERMINATE_TIMEOUT_MS);
          await client.close().catch(() => undefined);
        })();
        return closed;
      };
      open.add(close);
      const tracked = async <T>(request: () => Promise<T>): Promise<T> => {
        inFlight++;
        try {
          return await request();
        } finally {
          inFlight--;
          if (retired && inFlight === 0) void close();
        }
      };
      return {
        listTools: () =>
          tracked(() => client.listTools() as Promise<{ tools: McpTool[] }>),
        callTool: (params) =>
          tracked(() => client.callTool(params) as Promise<McpRawToolResult>),
        get sessionId() {
          return transport.sessionId;
        },
        // The cache's eviction: retire, and close once drained.
        dispose: async () => {
          retired = true;
          if (inFlight === 0) await close();
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
      const status = httpStatusOf(error);
      const stale = status === 404 && sessionId !== undefined;
      if (stale || (status === undefined && !(await isJsonRpcError(error)))) {
        await cache.evict(serverId, pending);
      }
      if (stale && !resent) return use(serverId, config, request, true);
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
      await Promise.all([...open].map((close) => close()));
    },
  };
}

/** How long closing a connection waits for the remote to end its session. */
const TERMINATE_TIMEOUT_MS = 2_000;

/** Settle when `work` settles or `ms` passes, whichever is first, never rejecting. */
async function bounded(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

/** Whether the remote answered the request with a JSON-RPC error. */
async function isJsonRpcError(error: unknown): Promise<boolean> {
  // The SDK is already loaded: a connection exists only once it was.
  const { ProtocolError } = await loadMcpClientSdk("mcp (http client)");
  return error instanceof ProtocolError;
}

/** The HTTP status the remote answered with, when the failure is one. */
function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}
