import {
  type CraftContext,
  type CraftPlugin,
  type EventName,
} from "@routecraft/routecraft";
import { McpServer } from "./server.ts";
import {
  ADAPTER_MCP_CLIENT_SERVERS,
  MCP_PLUGIN_REGISTERED,
  MCP_STDIO_MANAGERS,
  MCP_TOOL_REGISTRY,
} from "./types.ts";
import type {
  McpClientHttpConfig,
  McpClientStdioConfig,
  McpPluginOptions,
  McpTool,
} from "./types.ts";
import { validateMcpPluginOptions } from "./validate-options.ts";
import { StdioClientManager } from "./stdio-client-manager.ts";
import { McpToolRegistry } from "./tool-registry.ts";
import { buildAuthHeaders } from "./build-auth-headers.ts";

type ClientConfig = McpClientHttpConfig | McpClientStdioConfig;

function isStdioConfig(config: ClientConfig): config is McpClientStdioConfig {
  return "transport" in config && config.transport === "stdio";
}

/**
 * MCP plugin: one plugin per adapter. Starts the MCP server during plugin apply (before routes start) so startup failures fail context build. Exposes mcp() routes to external MCP clients.
 * Optional clients: register named remote MCP servers so routes can use .to(mcp("name:tool")) without passing url.
 * Stdio clients are spawned as subprocesses with auto-restart; HTTP clients are used for ephemeral tool calls.
 * All discovered external tools (stdio, HTTP) are stored in a unified McpToolRegistry for agent adapter discovery.
 * Required when any route uses .from(mcp(...)); the route will fail at start if this plugin is not applied.
 *
 * @experimental
 */
export function mcpPlugin(options: McpPluginOptions = {}): CraftPlugin {
  validateMcpPluginOptions(options);

  let server: McpServer | null = null;
  const stdioManagers = new Map<string, StdioClientManager>();
  const httpClients = new Map<
    string,
    { close(): Promise<void>; listTools(): Promise<{ tools: McpTool[] }> }
  >();
  const httpRefreshTimers: ReturnType<typeof setInterval>[] = [];
  let toolRegistry: McpToolRegistry | null = null;

  return {
    async apply(ctx: CraftContext) {
      ctx.setStore(
        MCP_PLUGIN_REGISTERED as keyof import("@routecraft/routecraft").StoreRegistry,
        true,
      );

      // Create and store tool registry
      toolRegistry = new McpToolRegistry();
      ctx.setStore(
        MCP_TOOL_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry,
        toolRegistry,
      );

      // Store stdio managers map so destination adapter can call tools on stdio clients
      ctx.setStore(
        MCP_STDIO_MANAGERS as keyof import("@routecraft/routecraft").StoreRegistry,
        stdioManagers as unknown as Map<
          string,
          {
            callTool(
              name: string,
              args: Record<string, unknown>,
            ): Promise<unknown>;
          }
        >,
      );

      if (options.clients && Object.keys(options.clients).length > 0) {
        const clientEntries = Object.entries(options.clients);
        const map = new Map<
          string,
          McpClientHttpConfig | McpClientStdioConfig | string
        >();
        for (const [k, v] of clientEntries) {
          map.set(k, v);
        }
        ctx.setStore(
          ADAPTER_MCP_CLIENT_SERVERS as keyof import("@routecraft/routecraft").StoreRegistry,
          map,
        );

        // Start stdio clients and list HTTP client tools
        for (const [serverId, config] of clientEntries) {
          if (isStdioConfig(config)) {
            await startStdioClient(ctx, serverId, config, toolRegistry);
          } else {
            // HTTP client: list tools immediately and optionally refresh periodically
            const httpConfig = config as McpClientHttpConfig;
            await listHttpClientTools(
              ctx,
              serverId,
              httpConfig.url,
              toolRegistry,
              httpConfig.auth,
            );
            setupHttpToolRefresh(
              ctx,
              serverId,
              httpConfig.url,
              toolRegistry,
              httpConfig.auth,
            );
          }

          const transport = isStdioConfig(config) ? "stdio" : "http";
          ctx.emit(
            `plugin:mcp:client:${serverId}:registered` as EventName,
            { serverId, transport } as Record<string, unknown>,
          );
        }
      }

      server = new McpServer(ctx, options);
      await server.start();
    },
    async teardown(ctx: CraftContext) {
      // Clear HTTP refresh timers
      for (const timer of httpRefreshTimers) {
        clearInterval(timer);
      }
      httpRefreshTimers.length = 0;

      // Close persistent HTTP clients
      for (const [serverId, client] of httpClients) {
        try {
          await client.close();
        } catch (error) {
          ctx.logger.error(
            { err: error, serverId, operation: "close" },
            "Failed to close HTTP client",
          );
        }
      }
      httpClients.clear();

      // Stop all stdio client managers
      for (const [serverId, manager] of stdioManagers) {
        try {
          await manager.stop();
        } catch (error) {
          ctx.logger.error(
            { err: error, serverId, operation: "stop" },
            "Failed to stop stdio client",
          );
        }
      }
      stdioManagers.clear();

      if (server) {
        try {
          await server.stop();
        } catch (error) {
          ctx.logger.error(
            { err: error, operation: "stop" },
            "Failed to stop MCP server plugin",
          );
        }
        server = null;
      }

      toolRegistry = null;
    },
  };

  async function startStdioClient(
    ctx: CraftContext,
    serverId: string,
    config: McpClientStdioConfig,
    registry: McpToolRegistry,
  ): Promise<void> {
    const managerOpts: import("./stdio-client-manager.ts").StdioClientManagerOptions =
      {
        serverId,
        command: config.command,
        args: config.args ?? [],
        maxRestarts: options.maxRestarts ?? 5,
        restartDelayMs: options.restartDelayMs ?? 1000,
        restartBackoffMultiplier: options.restartBackoffMultiplier ?? 2,
      };
    if (config.env !== undefined) managerOpts.env = config.env;
    if (config.cwd !== undefined) managerOpts.cwd = config.cwd;

    const manager = new StdioClientManager(
      managerOpts,
      ctx.logger,
      (event, details) => {
        ctx.emit(event as EventName, details as Record<string, unknown>);
      },
      (_serverId, tools) => {
        registry.setToolsForSource(_serverId, "stdio", tools);
      },
    );

    stdioManagers.set(serverId, manager);

    try {
      await manager.start();
    } catch (error) {
      ctx.logger.error(
        { err: error, serverId, operation: "start" },
        "Failed to start stdio client",
      );
      ctx.emit(
        `plugin:mcp:client:${serverId}:error` as EventName,
        {
          serverId,
          error,
        } as Record<string, unknown>,
      );
    }
  }

  async function getOrCreateHttpClient(
    serverId: string,
    url: string,
    auth?: McpClientHttpConfig["auth"],
  ): Promise<{
    close(): Promise<void>;
    listTools(): Promise<{ tools: McpTool[] }>;
  }> {
    const existing = httpClients.get(serverId);
    if (existing) return existing;

    const { Client } =
      await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } =
      await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

    const headers = await buildAuthHeaders(auth);
    const transportOptions = headers ? { requestInit: { headers } } : undefined;
    const transport = new (StreamableHTTPClientTransport as new (
      url: URL,
      options?: { requestInit?: { headers?: Record<string, string> } },
    ) => unknown)(new URL(url), transportOptions);
    const rawClient = new Client(
      { name: "routecraft-mcp-client", version: "1.0.0" },
      { capabilities: {} },
    );
    await (
      rawClient as unknown as { connect(t: unknown): Promise<void> }
    ).connect(transport);

    const typed = rawClient as unknown as {
      close(): Promise<void>;
      listTools(): Promise<{ tools: McpTool[] }>;
    };
    httpClients.set(serverId, typed);
    return typed;
  }

  async function listHttpClientTools(
    ctx: CraftContext,
    serverId: string,
    url: string,
    registry: McpToolRegistry,
    auth?: McpClientHttpConfig["auth"],
  ): Promise<void> {
    try {
      const client = await getOrCreateHttpClient(serverId, url, auth);

      const result = await client.listTools();
      const tools = result.tools ?? [];
      registry.setToolsForSource(serverId, "http", tools);

      ctx.emit(
        `plugin:mcp:client:${serverId}:tools:listed` as EventName,
        {
          serverId,
          toolCount: tools.length,
        } as Record<string, unknown>,
      );
    } catch (error) {
      // Connection may have gone stale; discard so next attempt reconnects
      httpClients.delete(serverId);
      ctx.logger.warn(
        { err: error, serverId, url, operation: "listTools" },
        "Failed to list tools from HTTP client",
      );
    }
  }

  function setupHttpToolRefresh(
    ctx: CraftContext,
    serverId: string,
    url: string,
    registry: McpToolRegistry,
    auth?: McpClientHttpConfig["auth"],
  ): void {
    const interval = options.toolRefreshIntervalMs ?? 60_000;
    if (interval <= 0) return;

    const timer = setInterval(() => {
      void listHttpClientTools(ctx, serverId, url, registry, auth);
    }, interval);
    httpRefreshTimers.push(timer);
  }
}
