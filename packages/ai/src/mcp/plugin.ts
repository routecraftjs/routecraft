import type { CraftContext, CraftPlugin } from "@routecraft/routecraft";
import { McpServer } from "./server.ts";
import { ADAPTER_MCP_CLIENT_SERVERS, MCP_PLUGIN_REGISTERED } from "./types.ts";
import type { McpPluginOptions } from "./types.ts";
import { validateMcpPluginOptions } from "./validate-options.ts";

/**
 * MCP plugin: one plugin per adapter. Starts the MCP server during plugin apply (before routes start) so startup failures fail context build. Exposes mcp() routes to external MCP clients.
 * Optional clients: register named remote MCP servers so routes can use .to(mcp("name:tool")) without passing url.
 * Required when any route uses .from(mcp(...)); the route will fail at start if this plugin is not applied.
 */
export function mcpPlugin(options: McpPluginOptions = {}): CraftPlugin {
  validateMcpPluginOptions(options);

  let server: McpServer | null = null;

  return {
    async apply(ctx: CraftContext) {
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

      server = new McpServer(ctx, options);
      await server.start();
    },
    async teardown(ctx: CraftContext) {
      if (server) {
        try {
          await server.stop();
        } catch (error) {
          ctx.logger.error(error, "Error stopping MCP server plugin");
        }
        server = null;
      }
    },
  };
}
