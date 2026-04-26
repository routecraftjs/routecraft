export { craftConfig } from "./craft.config.ts";
import { craft, direct, simple } from "@routecraft/routecraft";
import { agent, tools } from "@routecraft/ai";
import { z } from "zod";

const GreetInput = z.object({
  user: z
    .string()
    .trim()
    .min(1, { message: "User is required." })
    .describe("The user to greet."),
});
type GreetInput = z.infer<typeof GreetInput>;

export default craft()
  .id("call")
  .from(simple({ user: "Jaco" }))
  .to(direct("greet-user"))

  .id("greet-user")
  .title("Greet user")
  .description("Greet a user by name")
  .input({ body: GreetInput })
  .from<GreetInput>(direct())
  .debug()
  .to(
    agent({
      model: "gemini:gemini-3.1-pro-preview",
      system: "Format time and date at 5 June 2026 08:30",
      user: () => "What is the current time?",
      tools: tools(["currentTime"]),
    }),
  )
  .log();
