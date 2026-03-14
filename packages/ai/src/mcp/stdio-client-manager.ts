import type { McpTool } from "./types.ts";
import { extractContent } from "./extract-content.ts";

const MCP_SDK_INSTALL =
  'MCP stdio client requires "@modelcontextprotocol/sdk". Install it with: pnpm add @modelcontextprotocol/sdk';

export interface StdioClientManagerOptions {
  serverId: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  maxRestarts: number;
  restartDelayMs: number;
  restartBackoffMultiplier: number;
}

/** Logger interface matching pino child logger shape used in RouteCraft. */
interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/** Typed subset of the MCP SDK Client used by StdioClientManager. */
interface McpSdkClient {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{ tools: McpTool[] }>;
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<{
    content?: Array<{ type: string; text?: string; data?: string }>;
  }>;
}

/**
 * Manages a single stdio MCP client subprocess.
 *
 * Delegates to the MCP SDK's Client + StdioClientTransport for process spawning,
 * protocol handling, and tool listing. Adds auto-restart with exponential backoff
 * and event bridging into RouteCraft's event system.
 */
export class StdioClientManager {
  private client: McpSdkClient | null = null;
  private transport: unknown = null;
  private running = false;
  private stopping = false;
  private restartCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private tools: McpTool[] = [];

  /**
   * @param options - Subprocess command, restart policy, and server identity
   * @param logger - Logger matching the pino child logger shape
   * @param onEvent - Callback invoked for every lifecycle event
   * @param onToolsUpdated - Callback invoked whenever the tool list changes
   */
  constructor(
    private readonly options: StdioClientManagerOptions,
    private readonly logger: Logger,
    private readonly onEvent: (
      event: string,
      details: Record<string, unknown>,
    ) => void,
    private readonly onToolsUpdated: (
      serverId: string,
      tools: McpTool[],
    ) => void,
  ) {}

  /** Spawn the child process, perform the MCP handshake, and list initial tools. */
  async start(): Promise<void> {
    if (this.running) return;
    this.stopping = false;

    type SdkClientModule =
      typeof import("@modelcontextprotocol/sdk/client/index.js");
    type SdkStdioModule =
      typeof import("@modelcontextprotocol/sdk/client/stdio.js");

    let clientMod: SdkClientModule;
    let stdioMod: SdkStdioModule;

    try {
      clientMod = await import("@modelcontextprotocol/sdk/client/index.js");
      stdioMod = await import("@modelcontextprotocol/sdk/client/stdio.js");
    } catch {
      throw new Error(MCP_SDK_INSTALL);
    }

    const { serverId, command, args, env, cwd } = this.options;

    // Create transport (spawns child process)
    this.transport = new stdioMod.StdioClientTransport({
      command,
      args: args ?? [],
      ...(env ? { env } : {}),
      ...(cwd ? { cwd } : {}),
      stderr: "pipe",
    });

    // Wire up transport error/close handlers
    const transport = this.transport as {
      onclose?: () => void;
      onerror?: (error: Error) => void;
      stderr: {
        on?: (event: string, cb: (data: unknown) => void) => void;
      } | null;
    };

    transport.onerror = (error: Error) => {
      this.logger.error(
        { serverId, err: error },
        `Stdio client "${serverId}" transport error`,
      );
      this.onEvent(`plugin:mcp:client:${serverId}:error`, {
        serverId,
        error,
      });
    };

    transport.onclose = () => {
      if (!this.stopping) {
        this.running = false;
        this.handleDisconnect();
      }
    };

    // Log stderr from child process
    if (transport.stderr?.on) {
      transport.stderr.on("data", (data: unknown) => {
        this.logger.debug(
          { serverId, stderr: String(data).trimEnd() },
          `Stdio client "${serverId}" stderr`,
        );
      });
    }

    // Create client with listChanged support for auto tool refresh
    this.client = new clientMod.Client(
      { name: "routecraft-mcp-client", version: "1.0.0" },
      {
        capabilities: {},
        listChanged: {
          tools: {
            onChanged: (_error: unknown, tools: unknown) => {
              if (
                tools &&
                Array.isArray((tools as { tools: unknown[] }).tools)
              ) {
                this.tools = (tools as { tools: McpTool[] }).tools;
                this.onToolsUpdated(serverId, this.tools);
                this.onEvent(`plugin:mcp:client:${serverId}:tools:listed`, {
                  serverId,
                  toolCount: this.tools.length,
                });
              } else {
                // Server notified of change but SDK couldn't fetch; re-list manually
                void this.refreshTools();
              }
            },
          },
        },
      },
    ) as unknown as McpSdkClient;

    // Connect (performs MCP initialize handshake)
    await this.client.connect(this.transport);

    this.running = true;

    // List initial tools
    await this.refreshTools();

    this.logger.info(
      { serverId, toolCount: this.tools.length },
      `Stdio client "${serverId}" started`,
    );
    this.onEvent(`plugin:mcp:client:${serverId}:started`, {
      serverId,
      toolCount: this.tools.length,
    });
  }

  /** Gracefully close the client and transport, cancelling any pending restart. */
  async stop(): Promise<void> {
    this.stopping = true;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }

    const { serverId } = this.options;

    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Ignore cleanup errors
      }
      this.client = null;
    }

    if (this.transport) {
      const transportWithClose = this.transport as {
        close?: () => void | Promise<void>;
      };
      if (typeof transportWithClose.close === "function") {
        try {
          await Promise.resolve(transportWithClose.close());
        } catch {
          // Ignore cleanup errors
        }
      }
      this.transport = null;
    }

    this.running = false;
    this.logger.info({ serverId }, `Stdio client "${serverId}" stopped`);
    this.onEvent(`plugin:mcp:client:${serverId}:stopped`, {
      serverId,
      reason: "graceful",
    });
  }

  /**
   * Call a tool on the remote MCP server.
   * Delegates to SDK Client.callTool().
   *
   * @param name - Tool name to invoke
   * @param args - Arguments passed to the tool
   * @returns The tool result (text content extracted when available)
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.running || !this.client) {
      throw new Error(
        `Stdio client "${this.options.serverId}" is not running. Cannot call tool "${name}".`,
      );
    }

    const response = await this.client.callTool({
      name,
      arguments: args,
    });

    return extractContent(response);
  }

  /** @returns The current list of tools advertised by this server. */
  getTools(): McpTool[] {
    return [...this.tools];
  }

  /** @returns Whether the subprocess is connected and running. */
  isRunning(): boolean {
    return this.running;
  }

  private async refreshTools(): Promise<void> {
    if (!this.client) return;

    const { serverId } = this.options;

    try {
      const result = await this.client.listTools();
      this.tools = result.tools ?? [];
      this.onToolsUpdated(serverId, this.tools);
      this.onEvent(`plugin:mcp:client:${serverId}:tools:listed`, {
        serverId,
        toolCount: this.tools.length,
      });
    } catch (err) {
      this.logger.warn(
        { serverId, err },
        `Failed to list tools for stdio client "${serverId}"`,
      );
    }
  }

  private handleDisconnect(): void {
    const { serverId, maxRestarts, restartDelayMs, restartBackoffMultiplier } =
      this.options;

    // Clear stale tools so consumers don't see tools from a dead process
    if (this.tools.length > 0) {
      this.tools = [];
      this.onToolsUpdated(serverId, []);
    }

    this.logger.warn(
      { serverId },
      `Stdio client "${serverId}" disconnected unexpectedly`,
    );
    this.onEvent(`plugin:mcp:client:${serverId}:stopped`, {
      serverId,
      reason: "unexpected",
    });

    if (this.restartCount >= maxRestarts) {
      this.logger.error(
        { serverId, restartCount: this.restartCount, maxRestarts },
        `Stdio client "${serverId}" exceeded max restarts (${maxRestarts}). Giving up.`,
      );
      this.onEvent(`plugin:mcp:client:${serverId}:error`, {
        serverId,
        error: new Error(
          `Max restarts (${maxRestarts}) exceeded for stdio client "${serverId}"`,
        ),
      });
      return;
    }

    const delay =
      restartDelayMs * Math.pow(restartBackoffMultiplier, this.restartCount);
    this.logger.info(
      { serverId, restartCount: this.restartCount, delayMs: delay },
      `Scheduling restart for stdio client "${serverId}" in ${delay}ms`,
    );

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.restart();
    }, delay);
  }

  private async restart(): Promise<void> {
    const { serverId } = this.options;
    this.restartCount++;

    // Clean up stale references
    this.client = null;
    this.transport = null;

    try {
      await this.start();
      this.logger.info(
        { serverId, restartCount: this.restartCount },
        `Stdio client "${serverId}" restarted successfully`,
      );
      this.onEvent(`plugin:mcp:client:${serverId}:restarted`, {
        serverId,
        restartCount: this.restartCount,
      });
      // Reset restart count only after process stays alive for a stability period.
      // This prevents a flapping process from resetting the counter on every
      // momentary connection and bypassing maxRestarts.
      const stableMs = this.options.restartDelayMs * 2;
      this.stabilityTimer = setTimeout(() => {
        this.stabilityTimer = null;
        if (this.running) this.restartCount = 0;
      }, stableMs);
    } catch (err) {
      this.logger.error(
        { serverId, err, restartCount: this.restartCount },
        `Stdio client "${serverId}" restart failed`,
      );
      this.onEvent(`plugin:mcp:client:${serverId}:error`, {
        serverId,
        error: err,
      });
      // Schedule another restart attempt
      this.handleDisconnect();
    }
  }
}
