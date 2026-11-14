export { craftConfig } from "./craft.config.ts";
import { craft, direct, noop } from "@routecraft/routecraft";
import { mcp } from "@routecraft/ai";
import { z } from "zod";

const GreetInput = z.object({
  user: z.string().trim().min(1).describe("The user to greet."),
});

export default craft()
  .id("greet-user")
  .title("Greet user")
  .description("Greet a user by name")
  .input({ body: GreetInput })
  .from(direct(), mcp())
  .transform((body) => `Hello, ${body.user}!`)
  .log("info", "Greeting built", (ex) => ({ greeting: ex.body }))
  .to(noop());
