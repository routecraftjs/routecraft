import { assert } from "@std/assert";
import { context } from "@routecraft/dsl";
import routes from "./channel-adapter.ts";

Deno.test("Context loads", async () => {
  await context()
    .onStartup(() => {
      console.log("Startup");
    })
    .onShutdown(() => {
      console.log("Shutdown");
    })
    .routes(routes)
    .build()
    .run();

  assert(true, "Context loaded");
});
