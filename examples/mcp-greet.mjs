import { craft, log, noop } from "@routecraft/routecraft";
import { mcpPlugin, mcp } from "@routecraft/ai";
import { z } from "zod";

export const craftConfig = {
  plugins: [
    mcpPlugin({
      name: "routecraft",
      version: "1.0.0",
      transport: "stdio",
    }),
  ],
};

export default craft()
  .id("greet-user")
  .from(
    mcp("greet-user", {
      description: "Greet a user by name",
      schema: z.object({
        user: z.string().describe("The user to greet."),
      }),
    }),
  )
  .tap(log())
  .transform((payload) => ({ message: `Hello, ${payload.user}!` }))
  .to(noop());
