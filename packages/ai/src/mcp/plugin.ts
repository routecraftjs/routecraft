import {
  AUTHORITY,
  CREDENTIALS,
  ENFORCEMENT,
  evaluateEnablementOnce,
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
import type { AuthProvider } from "@modelcontextprotocol/client";
import {
  coalescedAuthProvider,
  connectHint,
  connectOwner,
  isConnectAuth,
  StoreOAuthProvider,
} from "./connect.ts";
import { createMcpHttpConnections } from "./http-connections.ts";

type ClientConfig = McpClientHttpConfig | McpClientStdioConfig;

/**
 * Where an `mcpPlugin()` descriptor carries its options, for `craft
 * connect`. Enumerable and keyed by a registered symbol, so a spread
 * descriptor or a second copy of the package still carries them.
 */
const PLUGIN_OPTIONS = Symbol.for("routecraft.ai.mcp.options");

/**
 * The options an `mcpPlugin()` descriptor was built with, or `undefined`
 * for any other plugin.
 *
 * @internal
 */
export function mcpPluginOptions(
  plugin: unknown,
): McpPluginOptions | undefined {
  return typeof plugin === "object" && plugin !== null
    ? ((plugin as Record<symbol, unknown>)[PLUGIN_OPTIONS] as
        McpPluginOptions | undefined)
    : undefined;
}

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

  const plugin: Plugin = {
    id: "routecraft.ai.mcp",
    provides: [MCP],
    requires: [AUTHORITY],
    optional: [WEB_INGRESS, ENFORCEMENT, CREDENTIALS],
    async bind(c: PluginContext) {
      const stdio = new Map<string, StdioClientManager>();
      const clients = new Map<string, McpClientConfig>();
      const disabledClients = new Map<string, string>();
      const authProviders = new Map<string, AuthProvider>();
      // Shared, so the disposer that removes a manager removes what dispatch sees.
      const service: McpService = createMcpService({
        stdio,
        clients,
        disabledClients,
        http: createMcpHttpConnections({ authProviders }),
      });

      // A client that logs in and has lost its credential is switched off
      // where it stands, as `enabled` would have, so the rest runs on.
      const disable = (serverId: string, reason: string): void => {
        if (disabledClients.has(serverId)) return;
        clients.delete(serverId);
        authProviders.delete(serverId);
        disabledClients.set(serverId, reason);
        service.tools.removeSource(serverId);
        c.logger.warn(
          { serverId, reason },
          "MCP client is disabled; not connecting",
        );
        c.emit(
          `plugin:mcp:client:${serverId}:disabled` as EventName,
          { serverId, reason } as Record<string, unknown>,
        );
      };
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
        if (config.enabled !== undefined) {
          const state = await evaluateEnablementOnce(
            config.enabled,
            `MCP client "${serverId}" enabled`,
            (err) => {
              c.logger.warn(
                { err, serverId },
                "MCP client enabled predicate threw; the client stays disabled",
              );
            },
          );
          if (!state.enabled) {
            // Declared, so a reference to it is not a typo; off, so nothing
            // is spawned, connected or listed for it.
            disabledClients.set(serverId, state.reason);
            c.logger.info(
              { serverId, reason: state.reason },
              "MCP client is disabled by its enabled declaration; not connecting",
            );
            continue;
          }
        }
        if (!isStdioConfig(config) && isConnectAuth(config.auth)) {
          const reason = await loginCredential(c, serverId);
          if (reason !== undefined) {
            disable(serverId, reason);
            continue;
          }
          authProviders.set(
            serverId,
            coalescedAuthProvider(
              new StoreOAuthProvider({
                serverId,
                options: config.auth.options,
                store: c.require(CREDENTIALS),
                onLoginRequired: (why) => disable(serverId, why),
              }),
            ),
          );
        }
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
          enforcement: () => c.lookup(ENFORCEMENT),
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
  return Object.assign(plugin, { [PLUGIN_OPTIONS]: options });

  /**
   * Why a client that logs in cannot connect, or `undefined` when its
   * credential is in the store or the store could not be read. Read once
   * at bind: a credential that goes missing later is found by the refresh
   * that fails. A read that fails (a lock, a mount not up yet) leaves the
   * client enabled, as the same failure on a request does, so a passing
   * fault does not switch it off until a restart.
   */
  async function loginCredential(
    c: PluginContext,
    serverId: string,
  ): Promise<string | undefined> {
    const store = c.lookup(CREDENTIALS);
    if (store === undefined) {
      return "no credential store is installed";
    }
    try {
      const stored = await store.get(connectOwner(serverId));
      if (stored === undefined) {
        return `no stored credential; ${connectHint(serverId)}`;
      }
      return undefined;
    } catch (err) {
      c.logger.warn(
        { err, serverId },
        "Could not read the credential of an MCP client at bind; keeping it enabled",
      );
      return undefined;
    }
  }

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
    // Switched off since the last listing: its login was refused.
    if (!service.clients.has(serverId)) return;
    try {
      // On the client's shared connection. A failure the remote did not
      // answer evicts it, so the next refresh reconnects.
      const result = await service.http.listTools(serverId, config);
      // Disabled while the listing was in flight.
      if (!service.clients.has(serverId)) return;
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
