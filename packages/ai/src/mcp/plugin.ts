import type { CraftContext, CraftPlugin } from "@routecraft/routecraft";
import { MCPServer } from "./server.ts";

export function plugin(options: Record<string, unknown> = {}): CraftPlugin {
  return (ctx: CraftContext) => {
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
