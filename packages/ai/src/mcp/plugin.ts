import type { CraftContext, CraftPlugin } from "@routecraft/routecraft";
import { MCPServer } from "./server.ts";
import { ADAPTER_MCP_CLIENT_SERVERS, MCP_PLUGIN_REGISTERED } from "./types.ts";
import type { McpPluginOptions } from "./types.ts";
import { validateMcpPluginOptions } from "./validate-options.ts";

/**
 * MCP plugin: one plugin per adapter. Starts the MCP server on context start and exposes mcp() routes to external MCP clients.
 * Optional clients: register named remote MCP servers so routes can use .to(mcp("name:tool")) without passing url.
 * Required when any route uses .from(mcp(...)); the route will fail at start if this plugin is not applied.
 */
export function mcpPlugin(options: McpPluginOptions = {}): CraftPlugin {
  validateMcpPluginOptions(options);

  return (ctx: CraftContext) => {
    ctx.setStore(
      MCP_PLUGIN_REGISTERED as keyof import("@routecraft/routecraft").StoreRegistry,
      true,
    );

    if (options.clients && Object.keys(options.clients).length > 0) {
      const map = new Map(Object.entries(options.clients));
      ctx.setStore(
        ADAPTER_MCP_CLIENT_SERVERS as keyof import("@routecraft/routecraft").StoreRegistry,
        map,
      );
    }

    let server: MCPServer | null = null;

    ctx.on("contextStarted", async () => {
      server = new MCPServer(ctx, options);
      try {
        await server.start();
      } catch (error) {
        ctx.logger.error(error, "Failed to start MCP server plugin");
        throw error;
      }
    });

    ctx.on("contextStopping", async () => {
      if (server) {
        try {
          await server.stop();
        } catch (error) {
          ctx.logger.error(error, "Error stopping MCP server plugin");
        }
      }
    });
  };
}
