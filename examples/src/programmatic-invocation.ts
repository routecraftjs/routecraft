import { Command } from "commander";
import { direct, craft, noop, ContextBuilder } from "@routecraft/routecraft";

// Programmatic invocation: use CraftClient to dispatch into routes from
// any external framework (Commander, Express, Next.js, etc.).

// 1. Define your routes using direct() sources
const capabilities = craft()
  .id("greet")
  .from(direct())
  .transform((body) => `Hello, ${(body as { name: string }).name}!`)
  .to(noop())

  .id("fail")
  .from(direct())
  .transform(() => {
    throw new Error("Something went wrong");
  })
  .to(noop());

// 2. Build and start the context (don't await start -- direct sources block until aborted)
const contextBuilder = new ContextBuilder();
contextBuilder.routes(capabilities);
const { context, client } = await contextBuilder.build();
context.start();

// 3. Wire Commander with full control, dispatch into routes via client.send()
const program = new Command().name("my-tool").version("1.0.0");

program.hook("postAction", async () => {
  await context.stop();
});

program
  .command("greet")
  .description("Greet someone")
  .argument("<name>", "Who to greet")
  .action(async (name) => {
    const result = await client.send("greet", { name });
    // eslint-disable-next-line no-console
    console.log(result);
  });

program
  .command("fail")
  .description("A command that always fails")
  .action(async () => {
    try {
      const result = await client.send("fail", {});
      // eslint-disable-next-line no-console
      console.log(result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

await program.parseAsync();
