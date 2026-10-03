import { log, craft, simple, http, direct } from "@routecraft/routecraft";
import { mcp } from "@routecraft/ai";
import { z } from "zod";

const GreetInput = z.object({ userId: z.number() });
type GreetInput = z.infer<typeof GreetInput>;

// "greet" is the capability: it looks a user up by id and returns a greeting.
// It stands behind two doors. `direct()` is the in-process one, which the
// hello-world caller below and `craft exec` use; `mcp()` makes it a tool an
// agent can call. Discovery metadata (title, description) and the input schema
// live on the route builder, and the framework validates `.input()` against
// every incoming message, whichever door it came through.
const greetRoute = craft()
  .id("greet")
  .title("Greet user")
  .description("Look up a user by id and return a greeting message")
  .input({ body: GreetInput })
  .from(direct(), mcp())
  .enrich(
    http<GreetInput, { name: string }>({
      method: "GET",
      url: (ex) =>
        `https://jsonplaceholder.typicode.com/users/${ex.body.userId}`,
    }),
  )
  .transform((result) => `Hello, ${result.body.name}!`)
  .to(log());

// "hello-world" calls greet once at start, so the project shows it runs.
const helloWorldRoute = craft()
  .id("hello-world")
  .from(simple({ userId: 1 }))
  .to(direct<GreetInput>("greet"));

export default [greetRoute, helloWorldRoute];
