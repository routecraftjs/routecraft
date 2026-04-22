import { log, craft, simple, http, direct } from "@routecraft/routecraft";
import { z } from "zod";

const GreetInput = z.object({ userId: z.number() });
type GreetInput = z.infer<typeof GreetInput>;

// "greet" service: receives a user id via the direct endpoint,
// fetches the user, and logs a greeting. Body type is inferred from the
// Standard Schema passed to direct(), so no cast is required.
const greetRoute = craft()
  .id("greet")
  .from(
    direct("greet", { description: "Greet a user by id", schema: GreetInput }),
  )
  .enrich(
    http<GreetInput, { name: string }>({
      method: "GET",
      url: (ex) =>
        `https://jsonplaceholder.typicode.com/users/${ex.body.userId}`,
    }),
  )
  .transform((result) => `Hello, ${result.body.name}!`)
  .log()
  .to(log());

// "hello-world" caller: dispatches a user id to the greet service.
const helloWorldRoute = craft()
  .id("hello-world")
  .from(simple({ userId: 1 }))
  .to(direct<GreetInput>("greet"));

export default [greetRoute, helloWorldRoute];
