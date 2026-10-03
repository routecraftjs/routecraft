import {
  AUTHORITY,
  type Plugin,
  type PluginContext,
  type EventName,
  parseDuration,
  rejectStaleOptions,
  WEB_INGRESS,
} from "@routecraft/routecraft";
import { McpServer } from "./server.ts";
import { connectMcpHttpClient } from "./sdk.ts";
import {
  createConnectionCache,
  type ConnectionCache,
} from "./http-client-cache.ts";
import { MCP, createMcpService, type McpService } from "./port.ts";
import type {
  McpClientHttpConfig,
  McpClientStdioConfig,
  McpPluginOptions,
  McpStdioToolCaller,
  McpTool,
} from "./types.ts";
import { validateMcpPluginOptions } from "./validate-options.ts";
import {
  StdioClientManager,
  type StdioClientManagerOptions,
} from "./stdio-client-manager.ts";
import type { McpToolRegistry } from "./tool-registry.ts";

type ClientConfig = McpClientHttpConfig | McpClientStdioConfig;

interface HttpClient {
  listTools(): Promise<{ tools: McpTool[] }>;
  /** Close the client AND its transport; closing the client alone leaks the socket. */
  dispose(): Promise<void>;
}

function isStdioConfig(config: ClientConfig): config is McpClientStdioConfig {
  return "transport" in config && config.transport === "stdio";
}

/**
 * MCP plugin: one plugin per adapter. Exposes mcp() routes to external MCP clients.
 * bind() validates options, registers clients, and mounts the HTTP transport on its named server, so misconfiguration fails context build; the server itself starts in the start() hook, after routes are up, and a failure there fails context.start().
 * Optional clients: register named remote MCP servers so routes can use .to(mcp("name:tool")) without passing url.
 * Stdio clients are spawned as subprocesses with auto-restart; HTTP clients are used for ephemeral tool calls.
 * All discovered external tools (stdio, HTTP) are stored in a unified McpToolRegistry for agent adapter discovery.
 * Required when any route uses .from(mcp(...)); the route will fail at start if this plugin is not applied.
 *
 * Everything bind acquires (subprocesses, HTTP clients, refresh timers, the
 * server) belongs to the application that bound it and is released through
 * `c.onDispose` as soon as it exists, so a bind that throws partway releases
 * it too, and two applications built from one descriptor never share it.
 */
export function mcpPlugin(options: McpPluginOptions = {}): Plugin {
  rejectStaleOptions(options, "mcpPlugin");
  validateMcpPluginOptions(options);

  const servers = new WeakMap<PluginContext, McpServer>();

  return {
    id: "routecraft.ai.mcp",
    provides: [MCP],
    requires: [AUTHORITY],
    optional: [WEB_INGRESS],
    async bind(c: PluginContext) {
      const stdio = new Map<string, StdioClientManager>();
      // Shared, so the disposer that removes a manager removes what dispatch sees.
      const service: McpService = {
        ...createMcpService(),
        stdio: stdio as Map<string, McpStdioToolCaller>,
      };
      c.provide(MCP, service);

      // Registered ahead of every refresh timer: disposers run in reverse, so
      // no refresh can reopen a client once the cache has been emptied.
      const httpClients = createConnectionCache<HttpClient>();
      c.onDispose(() =>
        httpClients.disposeAll((error, serverId) => {
          c.logger.error(
            { err: error, serverId, operation: "close" },
            "Failed to close HTTP client",
          );
        }),
      );

      for (const [serverId, config] of Object.entries(options.clients ?? {})) {
        service.clients.set(serverId, config);
        if (isStdioConfig(config)) {
          await startStdioClient(c, stdio, serverId, config, service.tools);
        } else {
          await listHttpClientTools(
            c,
            httpClients,
            serverId,
            config.url,
            service.tools,
            config.auth,
          );
          setupHttpToolRefresh(
            c,
            httpClients,
            serverId,
            config.url,
            service.tools,
            config.auth,
          );
        }

        const transport = isStdioConfig(config) ? "stdio" : "http";
        c.emit(
          `plugin:mcp:client:${serverId}:registered` as EventName,
          { serverId, transport } as Record<string, unknown>,
        );
      }

      const server = new McpServer(
        {
          logger: c.logger,
          emit: (event, details) => c.emit(event, details),
          observe: (event, handler) => c.observe(event, handler),
          service,
          ingress: c,
          authority: c.require(AUTHORITY),
        },
        options,
      );
      servers.set(c, server);
      c.onDispose(async () => {
        servers.delete(c);
        try {
          await server.stop();
        } catch (error) {
          c.logger.error(
            { err: error, operation: "stop" },
            "Failed to stop MCP server plugin",
          );
        }
      });
      await server.prepare();
    },
    async start(c: PluginContext) {
      await servers.get(c)?.start();
    },
  };

  async function startStdioClient(
    c: PluginContext,
    managers: Map<string, StdioClientManager>,
    serverId: string,
    config: McpClientStdioConfig,
    registry: McpToolRegistry,
  ): Promise<void> {
    const managerOpts: StdioClientManagerOptions = {
      serverId,
      command: config.command,
      args: config.args ?? [],
      maxRestarts: options.maxRestarts ?? 5,
      restartDelayMs:
        options.restartDelay === undefined
          ? 1000
          : parseDuration(options.restartDelay, "mcpPlugin.restartDelay"),
      restartBackoffMultiplier: options.restartBackoffMultiplier ?? 2,
    };
    if (config.env !== undefined) managerOpts.env = config.env;
    if (config.cwd !== undefined) managerOpts.cwd = config.cwd;

    const manager = new StdioClientManager(
      managerOpts,
      c.logger,
      (event, details) => {
        c.emit(event as EventName, details as Record<string, unknown>);
      },
      (_serverId, tools) => {
        registry.setToolsForSource(_serverId, "stdio", tools);
      },
    );

    managers.set(serverId, manager);
    // Before start: a start that fails can still have armed a restart timer.
    c.onDispose(async () => {
      managers.delete(serverId);
      try {
        await manager.stop();
      } catch (error) {
        c.logger.error(
          { err: error, serverId, operation: "stop" },
          "Failed to stop stdio client",
        );
      }
    });

    try {
      await manager.start();
    } catch (error) {
      c.logger.error(
        { err: error, serverId, operation: "start" },
        "Failed to start stdio client",
      );
      c.emit(
        `plugin:mcp:client:${serverId}:error` as EventName,
        {
          serverId,
          error,
        } as Record<string, unknown>,
      );
    }
  }

  function getOrCreateHttpClient(
    httpClients: ConnectionCache<HttpClient>,
    serverId: string,
    url: string,
    auth?: McpClientHttpConfig["auth"],
  ): Promise<HttpClient> {
    return httpClients.getOrCreate(serverId, async () => {
      const { client: rawClient, transport } = await connectMcpHttpClient(
        new URL(url),
        auth,
      );
      const typed = rawClient as unknown as {
        close(): Promise<void>;
        listTools(): Promise<{ tools: McpTool[] }>;
      };

      // Both handles are retained: closing the client does not close its
      // transport, so a cache that kept only the client would leak a socket
      // per entry on teardown and per failed refresh.
      return {
        listTools: () => typed.listTools(),
        dispose: async (): Promise<void> => {
          try {
            await typed.close();
          } catch {
            // Ignore cleanup errors
          }
          try {
            await transport.close();
          } catch {
            // Ignore cleanup errors
          }
        },
      };
    });
  }

  async function listHttpClientTools(
    c: PluginContext,
    httpClients: ConnectionCache<HttpClient>,
    serverId: string,
    url: string,
    registry: McpToolRegistry,
    auth?: McpClientHttpConfig["auth"],
  ): Promise<void> {
    let pending: Promise<HttpClient> | undefined;
    try {
      pending = getOrCreateHttpClient(httpClients, serverId, url, auth);
      const client = await pending;

      const result = await client.listTools();
      const tools = result.tools ?? [];
      registry.setToolsForSource(serverId, "http", tools);

      c.emit(
        `plugin:mcp:client:${serverId}:tools:listed` as EventName,
        {
          serverId,
          toolCount: tools.length,
        } as Record<string, unknown>,
      );
    } catch (error) {
      // Connection may have gone stale; discard so the next attempt
      // reconnects, and dispose it so an unreachable remote does not leak a
      // client and a transport per refresh interval. `evict` drops the entry
      // only when it is still the one THIS refresh used, because overlapping
      // refreshes are possible (the interval can fire while a previous run is
      // still in flight) and evicting by key alone would let a failing run
      // dispose the healthy client a concurrent run had just cached.
      if (pending) await httpClients.evict(serverId, pending);
      c.logger.warn(
        { err: error, serverId, url, operation: "listTools" },
        "Failed to list tools from HTTP client",
      );
    }
  }

  function setupHttpToolRefresh(
    c: PluginContext,
    httpClients: ConnectionCache<HttpClient>,
    serverId: string,
    url: string,
    registry: McpToolRegistry,
    auth?: McpClientHttpConfig["auth"],
  ): void {
    const interval =
      options.toolRefreshInterval === undefined
        ? 60_000
        : parseDuration(
            options.toolRefreshInterval,
            "mcpPlugin.toolRefreshInterval",
            0,
          );
    if (interval <= 0) return;

    const timer = setInterval(() => {
      void listHttpClientTools(c, httpClients, serverId, url, registry, auth);
    }, interval);
    c.onDispose(() => clearInterval(timer));
  }
}
