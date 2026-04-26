export { craftConfig } from "./craft.config.ts";
import { craft, direct, simple } from "@routecraft/routecraft";
import { agent } from "@routecraft/ai";
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
      system:
        "You are a friendly greeter. Greet the user warmly in one sentence.",
      user: (exchange) => `Greet ${(exchange.body as GreetInput).user}.`,
    }),
  )
  .log();
