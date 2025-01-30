import { assert } from "@std/assert";
import { channel, context, log, routes, simple } from "@routecraft/dsl";

Deno.test("Context loads", async () => {
  const testContext = context()
    .routes(
      routes()
        .from({ id: "hello-world" }, simple(() => "hello-world"))
        .to(channel("hello-world"))
        .from(channel("hello-world"))
        .to(log()),
    )
    .build();

  const execution = testContext.start();

  await new Promise((r) => setTimeout(r, 100)); // Shorter wait syntax

  await testContext.stop(); // Await stop directly (if it returns a Promise)
  await execution; // Ensure execution is complete

  assert(true);
});
