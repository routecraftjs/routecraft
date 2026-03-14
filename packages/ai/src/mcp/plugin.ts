import {
  ADAPTER_DIRECT_REGISTRY,
  type CraftContext,
  type CraftPlugin,
  type DirectRouteMetadata,
  type EventName,
} from "@routecraft/routecraft";
import { McpServer } from "./server.ts";
import {
  ADAPTER_MCP_CLIENT_SERVERS,
  MCP_PLUGIN_REGISTERED,
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

type ClientConfig = McpClientHttpConfig | McpClientStdioConfig;

function isStdioConfig(config: ClientConfig): config is McpClientStdioConfig {
  return "transport" in config && config.transport === "stdio";
}

/**
 * MCP plugin: one plugin per adapter. Starts the MCP server during plugin apply (before routes start) so startup failures fail context build. Exposes mcp() routes to external MCP clients.
 * Optional clients: register named remote MCP servers so routes can use .to(mcp("name:tool")) without passing url.
 * Stdio clients are spawned as subprocesses with auto-restart; HTTP clients are used for ephemeral tool calls.
 * All discovered tools (local, stdio, HTTP) are stored in a unified McpToolRegistry for agent adapter discovery.
 * Required when any route uses .from(mcp(...)); the route will fail at start if this plugin is not applied.
 */
export function mcpPlugin(options: McpPluginOptions = {}): CraftPlugin {
  validateMcpPluginOptions(options);

  let server: McpServer | null = null;
  const stdioManagers = new Map<string, StdioClientManager>();
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
            );
            setupHttpToolRefresh(ctx, serverId, httpConfig.url, toolRegistry);
          }

          const transport = isStdioConfig(config) ? "stdio" : "http";
          ctx.emit(
            `plugin:mcp:client:${serverId}:registered` as EventName,
            { serverId, transport } as Record<string, unknown>,
          );
        }
      }

      // Populate local tools from mcp() routes as they start.
      // ADAPTER_DIRECT_REGISTRY is populated during route.start(), so we
      // re-scan on each route:started event. setToolsForSource replaces
      // all "local" entries, so repeated calls are idempotent.
      ctx.on("route:started", () => {
        if (toolRegistry) {
          populateLocalTools(ctx, toolRegistry);
        }
      });

      server = new McpServer(ctx, options);
      await server.start();
    },
    async teardown(ctx: CraftContext) {
      // Clear HTTP refresh timers
      for (const timer of httpRefreshTimers) {
        clearInterval(timer);
      }
      httpRefreshTimers.length = 0;

      // Stop all stdio client managers
      for (const [serverId, manager] of stdioManagers) {
        try {
          await manager.stop();
        } catch (error) {
          ctx.logger.error(error, `Error stopping stdio client "${serverId}"`);
        }
      }
      stdioManagers.clear();

      if (server) {
        try {
          await server.stop();
        } catch (error) {
          ctx.logger.error(error, "Error stopping MCP server plugin");
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
        registry.setToolsForSource(
          _serverId,
          "stdio",
          tools.map((t) => {
            const entry: {
              name: string;
              description?: string;
              inputSchema: Record<string, unknown>;
            } = {
              name: t.name,
              inputSchema: t.inputSchema as Record<string, unknown>,
            };
            if (t.description !== undefined) {
              entry.description = t.description;
            }
            return entry;
          }),
        );
      },
    );

    stdioManagers.set(serverId, manager);

    try {
      await manager.start();
    } catch (error) {
      ctx.logger.error(error, `Failed to start stdio client "${serverId}"`);
      ctx.emit(
        `plugin:mcp:client:${serverId}:error` as EventName,
        {
          serverId,
          error,
        } as Record<string, unknown>,
      );
    }
  }

  async function listHttpClientTools(
    ctx: CraftContext,
    serverId: string,
    url: string,
    registry: McpToolRegistry,
  ): Promise<void> {
    let client: { close(): Promise<void> } | undefined;
    try {
      const { Client } =
        await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } =
        await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

      const transport = new StreamableHTTPClientTransport(new URL(url));
      client = new Client(
        { name: "routecraft-mcp-client", version: "1.0.0" },
        { capabilities: {} },
      ) as unknown as { close(): Promise<void> };
      await (
        client as unknown as { connect(t: unknown): Promise<void> }
      ).connect(transport);

      const result = await (
        client as unknown as { listTools(): Promise<{ tools: McpTool[] }> }
      ).listTools();

      const tools = result.tools ?? [];
      registry.setToolsForSource(
        serverId,
        "http",
        tools.map((t) => {
          const entry: {
            name: string;
            description?: string;
            inputSchema: Record<string, unknown>;
          } = {
            name: t.name,
            inputSchema: t.inputSchema as Record<string, unknown>,
          };
          if (t.description !== undefined) {
            entry.description = t.description;
          }
          return entry;
        }),
      );

      ctx.emit(
        `plugin:mcp:client:${serverId}:tools:listed` as EventName,
        {
          serverId,
          toolCount: tools.length,
        } as Record<string, unknown>,
      );
    } catch (error) {
      ctx.logger.warn(
        error,
        `Failed to list tools from HTTP client "${serverId}" at ${url}`,
      );
    } finally {
      if (client) {
        try {
          await client.close();
        } catch {
          // best-effort cleanup
        }
      }
    }
  }

  function setupHttpToolRefresh(
    ctx: CraftContext,
    serverId: string,
    url: string,
    registry: McpToolRegistry,
  ): void {
    const interval = options.toolRefreshIntervalMs ?? 60_000;
    if (interval <= 0) return;

    const timer = setInterval(() => {
      void listHttpClientTools(ctx, serverId, url, registry);
    }, interval);
    httpRefreshTimers.push(timer);
  }

  function populateLocalTools(
    ctx: CraftContext,
    registry: McpToolRegistry,
  ): void {
    const directRegistry = ctx.getStore(ADAPTER_DIRECT_REGISTRY) as
      | Map<string, DirectRouteMetadata>
      | undefined;

    if (!directRegistry) return;

    const tools: Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
    }> = [];

    for (const meta of directRegistry.values()) {
      // Only include mcp() routes (those with a description)
      if (meta.description !== undefined) {
        tools.push({
          name: meta.endpoint,
          description: meta.description,
          inputSchema: schemaToJsonSchema(meta.schema),
        });
      }
    }

    registry.setToolsForSource("local", "local", tools);
  }

  function schemaToJsonSchema(schema: unknown): Record<string, unknown> {
    if (!schema || typeof schema !== "object") {
      return { type: "object" };
    }

    const standard = (schema as Record<string, unknown>)["~standard"] as
      | {
          jsonSchema?: {
            input?: (opts: {
              target: "draft-2020-12" | "draft-07" | "openapi-3.0";
            }) => Record<string, unknown>;
          };
        }
      | undefined;
    if (standard?.jsonSchema?.input) {
      try {
        return standard.jsonSchema.input({ target: "draft-07" });
      } catch {
        // Fall through to generic schema
      }
    }

    return { type: "object" };
  }
}
