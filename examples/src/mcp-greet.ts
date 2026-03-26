export { craftConfig } from "./craft.config.ts";
import { craft, log, noop } from "@routecraft/routecraft";
import { mcp } from "@routecraft/ai";
import { z } from "zod";

export default craft()
  .id("greet-user")
  .from(
    mcp("greet-user", {
      description: "Greet a user by name",
      schema: z.object({
        user: z
          .string()
          .trim()
          .min(1, { message: "User is required." })
          .describe("The user to greet."),
      }),
    }),
  )
  .filter(() => {
    if (!process.env["JWT_SECRET"]) return { reason: "JWT_SECRET not set" };
    return true;
  })
  .tap(log())
  .transform((payload) => ({ message: `Hello, ${payload.user}!` }))
  .to(noop());
