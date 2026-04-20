import { log, craft, simple, http, direct } from "@routecraft/routecraft";
import { z } from "zod";

const GreetInput = z.object({ userId: z.number() });
type GreetInput = z.infer<typeof GreetInput>;

export default craft()
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
  .to(log())

  .id("hello-world")
  .from(simple({ userId: 1 }))
  .to(direct<GreetInput>("greet"));
