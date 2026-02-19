import type { CraftContext, CraftPlugin } from "@routecraft/routecraft";
import { MCPServer } from "./server.ts";
import { MCP_PLUGIN_REGISTERED } from "./types.ts";
import type { McpPluginOptions } from "./types.ts";
import { validateMcpPluginOptions } from "./validate-options.ts";

/**
 * MCP plugin: one plugin per adapter. Starts the MCP server on context start and exposes mcp() routes to external MCP clients.
 * Required when any route uses .from(mcp(...)); the route will fail at start if this plugin is not applied.
 */
export function mcpPlugin(options: McpPluginOptions = {}): CraftPlugin {
  validateMcpPluginOptions(options);

  return (ctx: CraftContext) => {
    ctx.setStore(
      MCP_PLUGIN_REGISTERED as keyof import("@routecraft/routecraft").StoreRegistry,
      true,
    );

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
