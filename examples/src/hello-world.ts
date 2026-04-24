import { log, craft, simple, http, direct } from "@routecraft/routecraft";
import { z } from "zod";

const GreetInput = z.object({ userId: z.number() });
type GreetInput = z.infer<typeof GreetInput>;

// "greet" service: receives a user id via the direct endpoint, fetches the
// user, and logs a greeting. The route builder owns discovery metadata
// (title, description, input schema); the framework validates `input.body`
// before the pipeline runs.
const greetRoute = craft()
  .id("greet")
  .title("Greet user")
  .description("Look up a user by id and return a greeting message")
  .input({ body: GreetInput })
  .from<GreetInput>(direct())
  .enrich(
    http<GreetInput, { name: string }>({
      method: "GET",
      url: (ex) =>
        `https://jsonplaceholder.typicode.com/users/${ex.body.userId}`,
    }),
  )
  .transform((result) => `Hello, ${result.body.name}!`)
  .to(log());

// "hello-world" caller: dispatches a user id to the greet service.
const helloWorldRoute = craft()
  .id("hello-world")
  .from(simple({ userId: 1 }))
  .to(direct<GreetInput>("greet"));

export default [greetRoute, helloWorldRoute];
