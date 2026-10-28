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
import {
  MCP,
  createMcpService,
  type McpClientConfig,
  type McpService,
} from "./port.ts";
import type {
  McpClientHttpConfig,
  McpClientStdioConfig,
  McpPluginOptions,
} from "./types.ts";
import { validateMcpPluginOptions } from "./validate-options.ts";
import {
  StdioClientManager,
  type StdioClientManagerOptions,
} from "./stdio-client-manager.ts";
import type { McpToolRegistry } from "./tool-registry.ts";

type ClientConfig = McpClientHttpConfig | McpClientStdioConfig;

function isStdioConfig(config: ClientConfig): config is McpClientStdioConfig {
  return "transport" in config && config.transport === "stdio";
}

/**
 * MCP plugin: one plugin per adapter. Exposes mcp() routes to external MCP clients.
 * bind() validates options, registers clients, and mounts the HTTP transport on its named server, so misconfiguration fails context build; the server itself starts in the start() hook, after routes are up, and a failure there fails context.start().
 * Optional clients: register named remote MCP servers so routes can use .to(mcp("name:tool")) without passing url.
 * Stdio clients are spawned as subprocesses with auto-restart; each HTTP client keeps one connection, shared by its tool listing and its calls.
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
      const clients = new Map<string, McpClientConfig>();
      // Shared, so the disposer that removes a manager removes what dispatch sees.
      const service: McpService = createMcpService({ stdio, clients });
      c.provide(MCP, service);

      // Registered ahead of every refresh timer: disposers run in reverse, so
      // no refresh can reopen a client once the connections are closed.
      c.onDispose(() =>
        service.http.disposeAll((error, serverId) => {
          c.logger.error(
            { err: error, serverId, operation: "close" },
            "Failed to close HTTP client",
          );
        }),
      );

      for (const [serverId, config] of Object.entries(options.clients ?? {})) {
        clients.set(serverId, config);
        if (isStdioConfig(config)) {
          await startStdioClient(c, stdio, serverId, config, service.tools);
        } else {
          await listHttpClientTools(c, service, serverId, config);
          setupHttpToolRefresh(c, service, serverId, config);
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

  async function listHttpClientTools(
    c: PluginContext,
    service: McpService,
    serverId: string,
    config: McpClientHttpConfig,
  ): Promise<void> {
    try {
      // On the client's shared connection. A failure the remote did not
      // answer evicts it, so the next refresh reconnects.
      const result = await service.http.listTools(serverId, config);
      const tools = result.tools ?? [];
      service.tools.setToolsForSource(serverId, "http", tools);

      c.emit(
        `plugin:mcp:client:${serverId}:tools:listed` as EventName,
        {
          serverId,
          toolCount: tools.length,
        } as Record<string, unknown>,
      );
    } catch (error) {
      c.logger.warn(
        { err: error, serverId, url: config.url, operation: "listTools" },
        "Failed to list tools from HTTP client",
      );
    }
  }

  function setupHttpToolRefresh(
    c: PluginContext,
    service: McpService,
    serverId: string,
    config: McpClientHttpConfig,
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
      void listHttpClientTools(c, service, serverId, config);
    }, interval);
    c.onDispose(() => clearInterval(timer));
  }
}
