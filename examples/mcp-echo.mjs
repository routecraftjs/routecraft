import { craft, log, noop } from "@routecraft/routecraft";
import { tool } from "@routecraft/ai";
import { z } from "zod";

export const echoRoute = craft()
  .id("echo-tool")
  .from(
    tool("echo", {
      description: "Echo back the input message",
      schema: z.object({
        message: z.string().describe("The message to echo"),
      }),
    }),
  )
  .transform((payload) => ({ message: payload.message }))
  .tap(log())
  .to(noop());
