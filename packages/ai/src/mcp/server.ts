import type { CraftContext, DirectRouteMetadata } from "@routecraft/routecraft";
import { DirectAdapter, DefaultExchange } from "@routecraft/routecraft";
import type { MCPServerOptions } from "./types.ts";

/** Resolved options with defaults applied (internal use). */
type MCPServerResolvedOptions = Required<
  Pick<MCPServerOptions, "name" | "version" | "transport" | "port" | "host">
> &
  Pick<MCPServerOptions, "tools">;

/**
 * MCPServer wraps the MCP SDK and bridges it to RouteCraft's DirectChannel infrastructure.
 * It reads the tool registry lazily (on first tools/list request) to ensure routes have subscribed.
 *
 * Note: Uses dynamic imports to avoid TypeScript compatibility issues with the MCP SDK.
 * Supports both stdio and streamable-http transports.
 */
export class MCPServer {
  private context: CraftContext;
  private options: MCPServerResolvedOptions;
  private server: unknown = null;
  private transport: unknown = null;
  private running = false;

  constructor(context: CraftContext, options: MCPServerOptions = {}) {
    this.context = context;
    this.options = {
      name: "routecraft",
      version: "1.0.0",
      transport: "stdio",
      port: 3001,
      host: "localhost",
      ...options,
    };
  }

  /**
   * Start the MCP server and listen for connections
   */
  async start(): Promise<void> {
    if (this.running) {
      this.context.logger.warn("MCP server already running");
      return;
    }

    try {
      const transport = this.options.transport;

      if (transport === "http") {
        await this.startHttp();
      } else {
        await this.startStdio();
      }

      this.running = true;
      this.context.logger.info(
        `MCP server started (${this.options.name}@${this.options.version}) on ${transport}`,
      );
    } catch (error) {
      this.context.logger.error(error, "Failed to start MCP server");
      throw error;
    }
  }

  /**
   * Start stdio transport
   */
  private async startStdio(): Promise<void> {
    // Dynamically import SDK to avoid TypeScript compatibility issues
    const { Server } =
      await import("@modelcontextprotocol/sdk/server/index.js");
    const { StdioServerTransport } =
      await import("@modelcontextprotocol/sdk/server/stdio.js");

    this.server = new Server(
      {
        name: this.options.name,
        version: this.options.version,
      },
      { capabilities: { tools: {} } },
    );

    await this.setupRequestHandlers();

    this.transport = new StdioServerTransport();
    const srvWithConnect = this.server as Record<
      string,
      (transport: unknown) => Promise<void>
    >;
    await srvWithConnect["connect"](this.transport);
  }

  /**
   * Start HTTP transport (streamable-http)
   */
  private async startHttp(): Promise<void> {
    // Dynamically import SDK
    const serverModule =
      await import("@modelcontextprotocol/sdk/server/index.js");
    const { Server } = serverModule;

    // Try to get StreamableHTTPServerTransport from the SDK
    // The MCP SDK exports this from the main server module
    const StreamableHTTPServerTransport: unknown = (
      serverModule as Record<string, unknown>
    )["StreamableHTTPServerTransport"];

    if (!StreamableHTTPServerTransport) {
      throw new Error(
        "StreamableHTTPServerTransport not found in MCP SDK - ensure @modelcontextprotocol/sdk v1.26.0+ is installed",
      );
    }

    this.server = new Server(
      {
        name: this.options.name,
        version: this.options.version,
      },
      { capabilities: { tools: {} } },
    );

    await this.setupRequestHandlers();

    const port = this.options.port;
    const host = this.options.host;

    // Create HTTP transport with port and host
    const TransportClass = StreamableHTTPServerTransport as {
      new (options: { port: number; host?: string }): unknown;
    };
    this.transport = new TransportClass({ port, host });

    const srvWithConnect = this.server as Record<
      string,
      (transport: unknown) => Promise<void>
    >;
    await srvWithConnect["connect"](this.transport);

    this.context.logger.info(
      `MCP HTTP server listening on http://${host}:${port}`,
    );
  }

  /**
   * Set up request handlers (shared by both transports).
   * Uses SDK request schemas so setRequestHandler receives a proper schema (method literal).
   */
  private async setupRequestHandlers(): Promise<void> {
    const typesModule = await import("@modelcontextprotocol/sdk/types.js");
    const t = typesModule as Record<string, unknown>;
    const ListToolsRequestSchema = t["ListToolsRequestSchema"];
    const CallToolRequestSchema = t["CallToolRequestSchema"];

    if (!ListToolsRequestSchema || !CallToolRequestSchema) {
      throw new Error(
        "MCP SDK types missing ListToolsRequestSchema or CallToolRequestSchema - ensure @modelcontextprotocol/sdk is installed",
      );
    }

    const srv = this.server as Record<
      string,
      (schema: unknown, handler: (request: unknown) => Promise<unknown>) => void
    >;

    srv["setRequestHandler"](ListToolsRequestSchema, async () => {
      return {
        tools: this.getAvailableTools(),
      };
    });

    srv["setRequestHandler"](
      CallToolRequestSchema,
      async (request: unknown) => {
        const req = request as Record<string, unknown>;
        const params = req["params"] as Record<string, unknown>;
        return await this.handleToolCall(
          (params["name"] as string) || "",
          (params["arguments"] as Record<string, unknown>) || {},
        );
      },
    );
  }

  /**
   * Stop the MCP server
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    try {
      if (this.transport) {
        const tr = this.transport as Record<string, () => Promise<void>>;
        await tr["close"]();
      }
      this.running = false;
      this.context.logger.info("MCP server stopped");
    } catch (error) {
      this.context.logger.error(error, "Error stopping MCP server");
    }
  }

  /**
   * Get list of tools that should be exposed via MCP.
   * Reads the registry lazily - called on every tools/list request and for tests.
   */
  getAvailableTools(): Array<Record<string, unknown>> {
    const registry = this.context.getStore(
      DirectAdapter.ADAPTER_DIRECT_REGISTRY,
    ) as Map<string, DirectRouteMetadata> | undefined;

    if (!registry) {
      return [];
    }

    // Get all tool routes (those with description)
    let tools = Array.from(registry.values()).filter(
      (t) => t.description !== undefined,
    );

    // Apply user filter if provided
    const toolsFilter = this.options.tools;
    if (toolsFilter) {
      if (Array.isArray(toolsFilter)) {
        const allowed = new Set(toolsFilter);
        tools = tools.filter((t) => allowed.has(t.endpoint));
      } else if (typeof toolsFilter === "function") {
        tools = tools.filter(toolsFilter);
      }
    }

    // Convert to MCP tool format
    return tools.map((meta) => this.metadataToMCPTool(meta));
  }

  /**
   * Convert RouteCraft tool metadata to MCP tool format
   */
  private metadataToMCPTool(
    metadata: DirectRouteMetadata,
  ): Record<string, unknown> {
    return {
      name: metadata.endpoint,
      description: metadata.description || "",
      inputSchema: this.schemaToJsonSchema(metadata.schema),
    };
  }

  /**
   * Convert StandardSchema to JSON Schema
   */
  private schemaToJsonSchema(schema: unknown): Record<string, unknown> {
    if (!schema) {
      return { type: "object" };
    }

    // Check for Zod 4 toJsonSchema method
    if (typeof schema === "object" && schema !== null && "_def" in schema) {
      const schemaObj = schema as Record<string, unknown>;
      if (typeof schemaObj["toJsonSchema"] === "function") {
        try {
          const schemaWithMethod = schema as Record<string, unknown>;
          const toJsonSchema = schemaWithMethod["toJsonSchema"] as (
            this: unknown,
          ) => Record<string, unknown>;
          return toJsonSchema.call(schemaWithMethod);
        } catch (error) {
          this.context.logger.debug(
            error,
            "Failed to convert schema to JSON Schema",
          );
          return { type: "object" };
        }
      }
    }

    // Check for standard-schema validate method and try to extract info
    if (
      typeof schema === "object" &&
      schema !== null &&
      "~standard" in schema
    ) {
      // For now, return generic object schema for standard-schema
      // In the future, we could enhance this based on the schema library
      return { type: "object", additionalProperties: true };
    }

    return { type: "object" };
  }

  /**
   * Handle a tool call from MCP client
   */
  private async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    try {
      // Get the direct channel store
      const channelStore = this.context.getStore(
        DirectAdapter.ADAPTER_DIRECT_STORE,
      ) as Map<string, Record<string, unknown>> | undefined;

      if (!channelStore) {
        const err = new Error("No direct channels available");
        this.context.emit("error", { error: err });
        return {
          content: [
            { type: "text", text: `Error: No direct channels available` },
          ],
        };
      }

      // Get the channel for this tool endpoint
      const channel = channelStore.get(toolName);
      if (!channel) {
        const err = new Error(`Tool not found: ${toolName}`);
        this.context.emit("error", { error: err });
        return {
          content: [
            { type: "text", text: `Error: Tool not found: ${toolName}` },
          ],
        };
      }

      // Create an exchange with the tool arguments
      const exchange = new DefaultExchange(this.context, {
        body: args,
        headers: {
          "routecraft.mcp.tool": toolName,
          "routecraft.mcp.session": `mcp-${Date.now()}`,
        },
      });

      // Send the exchange through the direct channel
      const channelTyped = channel as Record<
        string,
        (name: string, ex: unknown) => Promise<unknown>
      >;
      const resultExchange = (await channelTyped["send"](
        toolName,
        exchange,
      )) as Record<string, unknown>;

      // Convert result to MCP format
      const resultText =
        typeof resultExchange["body"] === "string"
          ? (resultExchange["body"] as string)
          : JSON.stringify(resultExchange["body"]);

      return {
        content: [{ type: "text", text: resultText }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.context.logger.error(error, `Tool call failed: ${toolName}`);
      this.context.emit("error", { error });
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
      };
    }
  }
}
