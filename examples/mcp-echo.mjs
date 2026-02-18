import { craft, log, noop } from "@routecraft/routecraft";
import { tool } from "@routecraft/ai";
import { z } from "zod";

export const echoRoute = craft()
  .id("greet-user")
  .from(
    tool("greet-user", {
      description: "Greet a user by name",
      schema: z.object({
        user: z.string().describe("The user to greet."),
      }),
    }),
  )
  .transform((payload) => ({ message: `Hello, ${payload.user}!` }))
  .tap(log())
  .to(noop());
